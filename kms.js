'use strict';

// ============================================================================
// Функция, внедряемая во вкладку KMS.
// Она сериализуется целиком, поэтому все хелперы объявлены внутри неё
// и снаружи ничего не используется.
// Возвращает { ok: true, result } либо { ok: false, error }.
// ============================================================================

async function kmsStep(step, payload) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(getter, timeoutMs = 25000, intervalMs = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = getter();
        if (v) return v;
      } catch (e) {
        /* элемент ещё не готов */
      }
      await sleep(intervalMs);
    }
    throw new Error(`не дождался элемента (шаг «${step}»)`);
  }

  // React не замечает прямое присвоение value — нужен нативный сеттер + input
  function setNativeValue(input, value) {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // ------------------------------------------------- мастер публикации
  // Подписи кнопок сравниваем по нормализованному тексту: внутри кнопки
  // бывают вложенные элементы и неразрывные пробелы, поэтому строгое
  // сравнение textContent иногда не срабатывает.
  const normText = (s) =>
    clean(String(s || '').replace(/ /g, ' '))
      .toLowerCase()
      .replace(/ё/g, 'е');

  const wizardRoot = () =>
    document.querySelector('.popup__container .wizard-wrapper') ||
    document.querySelector('.popup__container');

  const isVisible = (el) =>
    Boolean(
      el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    );

  const isDisabled = (b) =>
    Boolean(
      b.disabled ||
        b.getAttribute('aria-disabled') === 'true' ||
        /disabled/.test(b.className)
    );

  const wizardButtons = () => {
    const root = wizardRoot();
    if (!root) return [];
    return [...root.querySelectorAll('button')].filter(isVisible);
  };

  const wizardButton = (text) =>
    wizardButtons().find((b) => normText(b.textContent) === normText(text));

  // Кнопки шага мастера, кроме служебных. Если после отсева осталась ровно
  // одна — это и есть завершающая кнопка, как бы она ни называлась.
  const SERVICE_LABELS = ['отмена', 'назад', 'закрыть', 'продолжить', ''];

  const soleFinalAction = () => {
    const root = wizardRoot();
    if (!root) return null;
    const actions = [...root.querySelectorAll('button.wizard-wrapper__action')]
      .filter(isVisible)
      .filter((b) => !SERVICE_LABELS.includes(normText(b.textContent)));
    return actions.length === 1 ? actions[0] : null;
  };

  const describeButtons = () =>
    wizardButtons()
      .map(
        (b) =>
          `«${clean(b.textContent) || '·'}»${
            isDisabled(b) ? ' (неактивна)' : ''
          }`
      )
      .join(', ') || 'кнопок в окне нет';

  // Клик «как рукой»: часть компонентов реагирует не на click, а на
  // mousedown/pointerdown, и не видит кнопку, если она вне области прокрутки.
  async function realClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(80);

    const options = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', options));
    el.dispatchEvent(new MouseEvent('mousedown', options));
    try {
      el.focus();
    } catch (e) {
      /* кнопка не принимает фокус */
    }
    el.dispatchEvent(new PointerEvent('pointerup', options));
    el.dispatchEvent(new MouseEvent('mouseup', options));
    el.click();
    await sleep(100);
  }

  // Поле «Уведомление» в мастере публикации. Шаги мастера могут оставаться в
  // разметке скрытыми, поэтому по умолчанию берём только видимое поле: иначе
  // текст уйдёт в поле следующего шага, а мастер останется на текущем.
  const findNoteField = (allowHidden = false) => {
    const root = wizardRoot();
    if (!root) return null;

    const candidates = [
      ...root.querySelectorAll('.versioning-wrapper__notification textarea'),
      ...[...root.querySelectorAll('textarea')].filter((t) => {
        const label = t.closest('div, label');
        const around = label ? label.textContent : '';
        return /уведомл/i.test(`${t.placeholder || ''} ${around}`);
      }),
      ...root.querySelectorAll('textarea'),
    ];

    return (
      candidates.find(isVisible) || (allowHidden ? candidates[0] || null : null)
    );
  };

  // React включает завершающую кнопку по своему onBlur, а он подписан на
  // focusout: события «blur» ему недостаточно, поэтому снимаем фокус
  // по-настоящему и добавляем focusout.
  async function fillNotification(field, text) {
    field.focus();
    setNativeValue(field, text);
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    field.blur();
    await sleep(300);
  }

  const findCanvas = () =>
    document.querySelector(
      '.remirror-editor-wrapper .ProseMirror[contenteditable="true"]'
    ) || document.querySelector('.ProseMirror[contenteditable="true"]');

  // Текст блока без служебных якорей: якоря печатаются в разметку как
  // «pack»/«subject» и в осмысленный текст строки не входят.
  function blockText(block) {
    if (!block) return '';
    const copy = block.cloneNode(true);
    copy.querySelectorAll('a.m-anchor, .m-anchor').forEach((a) => a.remove());
    return clean(copy.textContent);
  }

  // Блоки, из которых состоит текст страницы. Заголовки первого и второго
  // уровня задают структуру, остальное — обычные строки.
  const BLOCK_SELECTOR =
    'h1, h2, h3, h4, h5, h6, p, li, td, th, pre, blockquote, div';

  // Строкой считаем только «лист» — блок, внутри которого нет других блоков.
  // Иначе обёртки разметки дали бы тот же текст ещё раз.
  const isLeafBlock = (el) => !el.querySelector(BLOCK_SELECTOR);

  // Корень содержимого статьи: ограничивает разбор, чтобы в структуру не
  // попали заголовки интерфейса вокруг статьи.
  function articleRoot() {
    const candidates = [
      '.m-article__content',
      '.m-article-content',
      '.m-article',
      'article',
      '[class*="article-content"]',
    ];
    for (const selector of candidates) {
      const node = document.querySelector(selector);
      if (node && node.querySelector('h1, h2')) return node;
    }
    return document.body;
  }

  // Блок верхнего уровня внутри полотна, в котором лежит узел
  function topLevelOf(canvas, node) {
    let n = node;
    while (n && n.parentElement && n.parentElement !== canvas) {
      n = n.parentElement;
    }
    return n;
  }

  // Последний блок раздела: идём от заголовка вниз, пока не встретим
  // новый заголовок первого или второго уровня либо конец документа.
  // При skipEmpty возвращаем последнюю непустую строку раздела — пустые
  // абзацы в хвосте не должны отодвигать точку вставки.
  function sectionEnd(canvas, heading, skipEmpty = false) {
    const start = topLevelOf(canvas, heading);
    let last = start;
    let lastFilled = null;
    let node = start ? start.nextElementSibling : null;

    while (node) {
      if (/^H[12]$/.test(node.tagName)) break;
      last = node;
      if (clean(node.textContent)) lastFilled = node;
      node = node.nextElementSibling;
    }
    return skipEmpty ? lastFilled || start : last;
  }

  // Блоки, внутрь которых нельзя ставить курсор: макеты, встроенные
  // страницы, таблицы. Позиция «в конце макета» для редактора не является
  // текстовой, и он переносит курсор туда, куда ему удобно, — обычно
  // в начало следующего заголовка. Вставка после этого рушит и последний
  // макет раздела, и сам заголовок.
  const STRUCTURAL = '.m-grid, .m-embedded, table, [contenteditable="false"]';

  const isStructural = (el) =>
    Boolean(el && (el.matches(STRUCTURAL) || el.querySelector(STRUCTURAL)));

  const TEXT_BLOCK_TAGS = /^(P|H[1-6]|LI|BLOCKQUOTE|PRE|DIV)$/;

  const isTextBlock = (el) =>
    Boolean(el) && TEXT_BLOCK_TAGS.test(el.tagName) && !isStructural(el);

  // Последняя обычная строка раздела: запасная точка вставки, если завести
  // пустую строку в самом конце раздела не удалось. Сам заголовок тоже
  // годится — в пустом разделе других строк просто нет.
  function lastTextBlockOf(canvas, heading) {
    const start = topLevelOf(canvas, heading);
    let found = isTextBlock(start) ? start : null;
    let node = start ? start.nextElementSibling : null;

    while (node) {
      if (/^H[12]$/.test(node.tagName)) break;
      if (isTextBlock(node)) found = node;
      node = node.nextElementSibling;
    }
    return found;
  }

  function caretAtEnd(canvas, element) {
    canvas.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  function htmlToPlainText(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || '';
  }

  // Вставка «как из буфера обмена»: Remirror сам разбирает text/html
  // через свою схему, поэтому форматирование сохраняется.
  async function pasteInto(canvas, plainText, html) {
    canvas.focus();
    const before = canvas.innerHTML;

    const dt = new DataTransfer();
    dt.setData('text/plain', plainText);
    if (html !== null && html !== undefined) dt.setData('text/html', html);

    canvas.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );
    await sleep(300);

    if (canvas.innerHTML !== before) return;

    // Резерв: редактор не принял синтетическую вставку
    const command = html ? 'insertHTML' : 'insertText';
    const value = html ? html : plainText;
    const inserted = document.execCommand(command, false, value);
    await sleep(200);

    if (!inserted && canvas.innerHTML === before) {
      throw new Error('редактор не принял вставку');
    }
  }

  // Готовим точку вставки в конце раздела: курсор должен оказаться в обычной
  // пустой строке верхнего уровня. Возвращаем описание места — панель пишет
  // его в журнал.
  async function insertionPoint(canvas, headingIndex, skipEmpty = false) {
    // Редактор перерисовывает разметку и заменяет узлы своими, поэтому
    // раздел каждый раз ищем заново, а не держим ссылки.
    const findHeading = () => [...canvas.querySelectorAll('h2')][headingIndex];

    const heading = findHeading();
    if (!heading) throw new Error('раздел не найден на полотне');

    const end = sectionEnd(canvas, heading, skipEmpty);
    if (!end) throw new Error('не удалось определить конец раздела');

    // Пустая строка в конце раздела уже есть — просто встаём в неё
    if (isTextBlock(end) && !clean(end.textContent)) {
      caretAtEnd(canvas, end);
      await sleep(150);
      return 'пустая строка в конце раздела';
    }

    // Раздел заканчивается обычной строкой — уходим на новую
    if (isTextBlock(end)) {
      caretAtEnd(canvas, end);
      await sleep(150);
      await pressEnter(canvas);
      await sleep(150);
      return 'новая строка после последней строки раздела';
    }

    // Раздел заканчивается макетом или таблицей: заводим пустую строку сами
    // и проверяем не ссылку на свой узел (редактор мог заменить его своим),
    // а то, чем теперь заканчивается раздел.
    const paragraph = document.createElement('p');
    paragraph.appendChild(document.createElement('br'));
    end.insertAdjacentElement('afterend', paragraph);
    await sleep(300);

    const created = sectionEnd(canvas, findHeading() || heading);
    if (isTextBlock(created) && !clean(created.textContent)) {
      caretAtEnd(canvas, created);
      await sleep(150);
      return 'новая строка после последнего макета раздела';
    }

    // Редактор пустую строку не принял. В начало следующего заголовка
    // вставать нельзя — он от этого перестаёт быть заголовком, поэтому
    // отступаем к последней обычной строке раздела.
    const fallback = lastTextBlockOf(canvas, findHeading() || heading);
    if (!fallback) {
      throw new Error(
        'в конце раздела некуда поставить курсор: раздел состоит из макетов, ' +
          'а пустую строку редактор не принял'
      );
    }

    caretAtEnd(canvas, fallback);
    await sleep(150);
    await pressEnter(canvas);
    await sleep(150);
    return 'новая строка перед макетами раздела (в самый конец встать не удалось)';
  }

  // Слепок структуры полотна: по нему сверяем, что вставка ничего не съела.
  function structureSnapshot(canvas) {
    return {
      html: canvas.innerHTML,
      headings: [...canvas.querySelectorAll('h1, h2, h3')].map(
        (h) => `${h.tagName} «${blockText(h)}»`
      ),
      embedded: [...canvas.querySelectorAll('.m-embedded')].map(
        (e) => e.getAttribute('data-article-id') || '?'
      ),
      grids: canvas.querySelectorAll('.m-grid').length,
    };
  }

  // Что должно добавиться на полотно после вставки этого куска разметки
  function expectedFromHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return {
      grids: tmp.querySelectorAll('.m-grid').length,
      embedded: [...tmp.querySelectorAll('.m-embedded')].map(
        (e) => e.getAttribute('data-article-id') || '?'
      ),
    };
  }

  // Что из прежнего содержимого пропало (с учётом повторов)
  function lost(before, after) {
    const rest = [...after];
    const gone = [];
    for (const item of before) {
      const at = rest.indexOf(item);
      if (at === -1) gone.push(item);
      else rest.splice(at, 1);
    }
    return gone;
  }

  // Разбор последствий вставки: пустая строка — всё хорошо.
  function damageReport(before, after, expected) {
    const goneHeadings = lost(before.headings, after.headings);
    if (goneHeadings.length) {
      return `вставка испортила заголовки (пропали: ${goneHeadings.join(', ')})`;
    }

    const goneEmbedded = lost(before.embedded, after.embedded);
    if (goneEmbedded.length) {
      return (
        `вставка удалила макеты раздела ` +
        `(пропали встроенные страницы: ${goneEmbedded.join(', ')})`
      );
    }

    const wantGrids = before.grids + expected.grids;
    if (after.grids !== wantGrids) {
      return `макетов на странице ${after.grids}, а должно быть ${wantGrids}`;
    }

    const missing = lost(expected.embedded, after.embedded);
    if (missing.length) {
      return `вставленный макет потерял ссылку на страницу ${missing.join(', ')}`;
    }
    return '';
  }

  // Вернулась ли структура к исходной: точное совпадение разметки требовать
  // нельзя — редактор всё равно перерисует её по-своему.
  const sameStructure = (before, now) =>
    lost(before.headings, now.headings).length === 0 &&
    lost(before.embedded, now.embedded).length === 0 &&
    now.grids === before.grids;

  // Откат неудачной вставки: редактор помнит историю, поэтому жмём Ctrl+Z,
  // пока разметка не совпадёт с исходной.
  async function undoTo(canvas, before) {
    const html = before.html;
    const options = {
      key: 'z',
      code: 'KeyZ',
      keyCode: 90,
      which: 90,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    };

    const restored = () =>
      canvas.innerHTML === html ||
      sameStructure(before, structureSnapshot(canvas));

    for (let i = 0; i < 6 && !restored(); i += 1) {
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent('keydown', options));
      canvas.dispatchEvent(new KeyboardEvent('keyup', options));
      await sleep(250);
      if (restored()) break;
      document.execCommand('undo');
      await sleep(250);
    }
    return restored();
  }

  async function pressEnter(canvas) {
    canvas.focus();
    const before = canvas.innerHTML;
    const options = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      charCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    };

    canvas.dispatchEvent(new KeyboardEvent('keydown', options));
    await sleep(60);
    canvas.dispatchEvent(new KeyboardEvent('keyup', options));
    await sleep(60);

    if (canvas.innerHTML !== before) return;

    const inserted = document.execCommand('insertParagraph', false);
    await sleep(60);
    if (!inserted && canvas.innerHTML === before) {
      throw new Error('редактор не обработал перенос строки');
    }
  }

  try {
    switch (step) {
      // ---------------------------------------------------------------- фаза 1
      case 'auth': {
        // Ждём либо форму входа, либо любой признак загруженного приложения
        const t0 = Date.now();
        while (Date.now() - t0 < 20000) {
          if (
            document.querySelector(
              'form.login__form, .layout-authentication__container'
            )
          ) {
            return { ok: true, result: { authorized: false } };
          }
          if (
            document.querySelector(
              '.m-article, .m-app-layout, .m-main-menu-logo, [class*="article"]'
            )
          ) {
            return { ok: true, result: { authorized: true } };
          }
          await sleep(300);
        }
        return { ok: false, error: 'страница KMS не загрузилась за 20 секунд' };
      }

      // ---------------------------------------------------------------- фаза 2
      // Структуру головной страницы читаем по заголовкам: первый уровень —
      // пакеты, второй — темы. Внутри темы запоминаем последнюю непустую
      // строку: её показываем пользователю в фазе 3.
      case 'scan-structure': {
        await sleep(500);
        let root = articleRoot();
        const t0 = Date.now();

        // Содержимое рисуется асинхронно: ждём появления заголовков, но не
        // падаем, если их нет — это отдельная ошибка конфигурации.
        while (Date.now() - t0 < 25000) {
          root = articleRoot();
          if (root.querySelector('h1, h2')) break;
          await sleep(400);
        }

        const packs = [];
        let orphanSubjects = 0;
        let pack = null;
        let subject = null;

        for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
          if (el.tagName === 'H1') {
            pack = { text: blockText(el), subjects: [] };
            subject = null;
            packs.push(pack);
            continue;
          }

          if (el.tagName === 'H2') {
            if (!pack) {
              orphanSubjects += 1;
              subject = null;
              continue;
            }
            subject = { text: blockText(el), lastLine: '' };
            pack.subjects.push(subject);
            continue;
          }

          if (!subject || !isLeafBlock(el)) continue;
          const text = blockText(el);
          if (text) subject.lastLine = text;
        }

        return { ok: true, result: { packs, orphanSubjects } };
      }

      // ------------------------------------------------- редактор: готовность
      case 'canvas': {
        const canvas = await waitFor(findCanvas, 15000);
        return { ok: true, result: { ready: Boolean(canvas) } };
      }

      // Быстрая проверка без ожидания: полотно есть и на нём уже
      // отрисовано содержимое. Используется для опроса фоновой вкладки.
      case 'canvas-check': {
        const canvas = findCanvas();
        if (!canvas) return { ok: true, result: { ready: false, blocks: 0 } };
        const blocks = canvas.querySelectorAll('h1, h2, h3, p, ul, ol, table')
          .length;
        return { ok: true, result: { ready: blocks > 0, blocks } };
      }

      case 'headings': {
        const canvas = await waitFor(findCanvas, 15000);
        const headings = [...canvas.querySelectorAll('h2')].map((h, i) => ({
          index: i,
          text: blockText(h) || clean(h.textContent),
        }));
        return { ok: true, result: { headings } };
      }

      // Разделы полотна с их пакетами: индекс считаем по заголовкам второго
      // уровня, чтобы он совпадал с индексом в шагах вставки.
      case 'outline': {
        const canvas = await waitFor(findCanvas, 15000);
        const sections = [];
        let pack = '';
        let index = -1;

        for (const node of canvas.querySelectorAll('h1, h2')) {
          if (node.tagName === 'H1') {
            pack = blockText(node) || clean(node.textContent);
            continue;
          }
          index += 1;
          sections.push({
            index,
            pack,
            text: blockText(node) || clean(node.textContent),
          });
        }
        return { ok: true, result: { sections } };
      }

      // ------------------------------------------------- вставка в раздел
      case 'insert-html': {
        const canvas = await waitFor(findCanvas, 15000);
        const headings = [...canvas.querySelectorAll('h2')];
        const heading = headings[payload.headingIndex];
        if (!heading) throw new Error('раздел не найден на полотне');

        const before = structureSnapshot(canvas);
        const expected = expectedFromHtml(payload.html);

        const where = await insertionPoint(canvas, payload.headingIndex);

        // Макет вставляем через insertHTML — так он приживается в схеме
        // редактора вместе с m-grid и m-embedded (проверено скриптом консоли).
        const beforeInsert = canvas.innerHTML;
        const inserted = document.execCommand('insertHTML', false, payload.html);
        await sleep(400);

        if (!inserted || canvas.innerHTML === beforeInsert) {
          await pasteInto(canvas, htmlToPlainText(payload.html), payload.html);
        }
        await sleep(300);

        // Проверяем, что вставка ничего не сломала: заголовки на месте,
        // прежние макеты целы, новый — добавился.
        const damage = damageReport(before, structureSnapshot(canvas), expected);
        if (damage) {
          const restored = await undoTo(canvas, before);
          throw new Error(
            `${damage}. ` +
              (restored
                ? 'Вставка отменена, страница осталась прежней.'
                : 'Отменить вставку не удалось — проверьте страницу вручную ' +
                  'и не публикуйте её, пока разметка не в порядке.')
          );
        }

        return { ok: true, result: { done: true, where } };
      }

      case 'insert-link': {
        const canvas = await waitFor(findCanvas, 15000);
        const headings = [...canvas.querySelectorAll('h2')];
        const heading = headings[payload.headingIndex];
        if (!heading) throw new Error('раздел не найден на полотне');

        const before = structureSnapshot(canvas);

        // Ссылку ставим сразу за последней непустой строкой раздела. Точку
        // вставки готовим так же, как для макета: встать в конец макета
        // нельзя — курсор уедет в следующий заголовок.
        const where = await insertionPoint(canvas, payload.headingIndex, true);

        // Ссылку вставляем обычным текстом: редактор сам превращает её в ссылку
        await pasteInto(canvas, payload.url, null);
        await sleep(300);

        const damage = damageReport(before, structureSnapshot(canvas), {
          grids: 0,
          embedded: [],
        });
        if (damage) {
          const restored = await undoTo(canvas, before);
          throw new Error(
            `${damage}. ` +
              (restored
                ? 'Вставка отменена, страница осталась прежней.'
                : 'Отменить вставку не удалось — проверьте страницу вручную ' +
                  'и не публикуйте её, пока разметка не в порядке.')
          );
        }

        return { ok: true, result: { done: true, where } };
      }

      // ---------------------------------------------------------------- фаза 5
      case 'fullwidth': {
        const btn = await waitFor(
          () => document.querySelector('div[data-tip="на всю ширину"] button'),
          8000
        );
        btn.click();
        return { ok: true, result: { done: true } };
      }

      case 'title': {
        const input = await waitFor(
          () =>
            document.querySelector(
              'input.m-ui-text-input__input[placeholder="Введите название контента"]'
            ) || document.querySelector('input.m-ui-text-input__input')
        );
        setNativeValue(input, payload);
        return { ok: true, result: { done: true } };
      }

      case 'content': {
        const canvas = await waitFor(findCanvas);
        canvas.focus();
        await sleep(300);
        await pasteInto(canvas, payload.text, payload.html);
        await sleep(400);
        return { ok: true, result: { done: true } };
      }

      // ------------------------------------------------- публикация (общая)
      case 'publish': {
        const btn = await waitFor(() => {
          const b = document.querySelector('button[title="Опубликовать"]');
          if (!b) return null;
          if (b.disabled || b.className.includes('--disabled')) return null;
          return b;
        }, 30000);
        btn.click();
        return { ok: true, result: { done: true } };
      }

      case 'modal-nav': {
        await waitFor(() =>
          document.querySelector('.popup__container .wizard-wrapper')
        );
        const li = await waitFor(() =>
          document.querySelector('li[data-tip="навигация"]')
        );
        if (!li.querySelector('.tab-item--active')) {
          li.click();
          await sleep(500);
        }
        return { ok: true, result: { done: true } };
      }

      case 'continue': {
        const btn = await waitFor(() => {
          const b = wizardButton('Продолжить');
          return b && !isDisabled(b) ? b : null;
        });
        await realClick(btn);
        await sleep(600);
        return { ok: true, result: { done: true } };
      }

      case 'notification': {
        const ta = await waitFor(() =>
          document.querySelector('.versioning-wrapper__notification textarea')
        );
        await fillNotification(ta, payload);
        return { ok: true, result: { done: true } };
      }

      // Мастер публикации целиком: доходим до поля «Уведомление», заполняем
      // его и проверяем, что текст удержался. У существующей страницы число
      // шагов «Продолжить» отличается от страницы, которую создают, поэтому
      // жмём не фиксированные три раза, а до появления самого поля.
      case 'publish-wizard': {
        await waitFor(
          () => document.querySelector('.popup__container .wizard-wrapper'),
          30000
        );

        const nav = document.querySelector('li[data-tip="навигация"]');
        if (nav && !nav.querySelector('.tab-item--active')) {
          nav.click();
          await sleep(600);
        }

        let note = findNoteField();
        let clicks = 0;

        while (!note && clicks < 8) {
          const next = wizardButton('Продолжить');
          if (!next) break;
          if (isDisabled(next)) {
            await sleep(500);
            note = findNoteField();
            continue;
          }
          await realClick(next);
          clicks += 1;
          await sleep(900);
          note = findNoteField();
        }

        // Поля не видно ни на одном шаге — пробуем скрытое: дальше шаг
        // завершения всё равно проведёт мастер до конца и повторит ввод.
        if (!note) note = findNoteField(true);

        if (!note) {
          throw new Error(
            `поле «Уведомление» не найдено в мастере публикации ` +
              `(шагов «Продолжить»: ${clicks}; в окне: ${describeButtons()})`
          );
        }

        // React иногда перерисовывает поле сразу после появления и сбрасывает
        // значение, поэтому пишем, проверяем и при необходимости повторяем.
        let value = '';
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await fillNotification(note, payload);

          const live = findNoteField() || note;
          note = live;
          value = live.value;
          if (value === payload) break;
        }

        if (value !== payload) {
          throw new Error(
            `поле «Уведомление» не приняло текст (в поле осталось: «${value}»)`
          );
        }

        return { ok: true, result: { clicks, value, buttons: describeButtons() } };
      }

      // Снимок состояния мастера без единого действия. Панель опрашивает
      // его, пока кнопка «Завершить» неактивна, и пишет об этом в журнал.
      case 'wizard-state': {
        if (!wizardRoot()) return { ok: true, result: { open: false } };

        const finish = wizardButton('Завершить') || soleFinalAction();
        const next = wizardButton('Продолжить');
        const field = findNoteField(true);

        return {
          ok: true,
          result: {
            open: true,
            finish: finish
              ? {
                  label: clean(finish.textContent),
                  disabled: isDisabled(finish),
                }
              : null,
            next: next ? { disabled: isDisabled(next) } : null,
            note: field ? { value: field.value, visible: isVisible(field) } : null,
            buttons: describeButtons(),
          },
        };
      }

      // Завершение мастера. Кнопка «Завершить» появляется не всегда сразу
      // после поля «Уведомление»: у части страниц за ним есть ещё шаг, а сама
      // кнопка какое-то время остаётся неактивной, пока форма не увидит
      // введённый текст. Поэтому не ищем кнопку один раз, а доводим мастер
      // до конца: дожимаем «Продолжить», подтверждаем текст уведомления и
      // проверяем, что клик по «Завершить» действительно сработал.
      case 'finish': {
        const noteText =
          payload && typeof payload === 'object' ? payload.note : payload;

        const t0 = Date.now();
        let advanced = 0;
        let attempts = 0;

        while (Date.now() - t0 < 45000) {
          if (!wizardRoot()) {
            return { ok: true, result: { done: true, closed: true, advanced } };
          }

          const finish = wizardButton('Завершить') || soleFinalAction();

          if (finish) {
            const label = clean(finish.textContent);

            if (!isDisabled(finish)) {
              await realClick(finish);
              attempts += 1;
              await sleep(800);

              // Клик засчитан, если мастер закрылся или ушёл с этого шага
              if (!wizardRoot() || !wizardButton(label)) {
                return {
                  ok: true,
                  result: { done: true, clicked: label, advanced, attempts },
                };
              }
              await sleep(700);
              continue;
            }

            // Кнопка неактивна: обычно форма ещё не приняла текст уведомления
            const field = findNoteField(true);
            if (field && noteText) await fillNotification(field, noteText);
            await sleep(600);
            continue;
          }

          const next = wizardButton('Продолжить');
          if (next && !isDisabled(next) && advanced < 8) {
            await realClick(next);
            advanced += 1;
            await sleep(900);

            // После перехода поле «Уведомление» может появиться пустым
            const field = findNoteField();
            if (field && noteText && field.value !== noteText) {
              await fillNotification(field, noteText);
            }
            continue;
          }

          await sleep(500);
        }

        throw new Error(
          `не удалось завершить мастер публикации ` +
            `(нажатий «Завершить»: ${attempts}, доп. шагов «Продолжить»: ` +
            `${advanced}; в окне: ${describeButtons()})`
        );
      }

      case 'wizard-closed': {
        await waitFor(
          () =>
            !document.querySelector('.popup__container .wizard-wrapper')
              ? true
              : null,
          90000
        );
        return { ok: true, result: { done: true } };
      }

      default:
        return { ok: false, error: `неизвестный шаг: ${step}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================================
// Оркестрация из панели
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exec(tabId, step, payload = null) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: kmsStep,
    args: [step, payload],
  });
  const res = injection && injection.result;
  if (!res || !res.ok) {
    throw new Error(res ? res.error : `нет ответа от вкладки (шаг «${step}»)`);
  }
  return res.result;
}

function waitTabComplete(tabId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('вкладка не загрузилась за отведённое время'));
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

// После «Завершить» SPA может менять адрес в несколько шагов, поэтому берём
// последний /wiki/<цифры>, игнорируем заранее известные идентификаторы и
// принимаем значение, только если оно продержалось два опроса подряд.
async function waitForPageId(tabId, ignoreIds, timeoutMs = 90000) {
  const t0 = Date.now();
  let candidate = null;

  while (Date.now() - t0 < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    const id = tab.url ? lastWikiId(tab.url) : null;

    if (id && !ignoreIds.has(id)) {
      if (id === candidate) return { id, url: tab.url };
      candidate = id;
    } else {
      candidate = null;
    }
    await sleep(400);
  }
  throw new Error('не дождался перехода на созданную страницу');
}

async function closeTabQuietly(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    /* вкладку уже закрыли вручную */
  }
}

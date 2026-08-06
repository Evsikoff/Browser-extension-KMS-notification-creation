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

  const findByText = (selector, text) =>
    [...document.querySelectorAll(selector)].find(
      (b) => b.textContent.trim() === text
    );

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

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

        const end = sectionEnd(canvas, heading);
        if (!end) throw new Error('не удалось определить конец раздела');

        caretAtEnd(canvas, end);
        await sleep(200);

        // Макет вставляем через insertHTML — так он приживается в схеме
        // редактора вместе с m-grid и m-embedded (проверено скриптом консоли).
        const before = canvas.innerHTML;
        const inserted = document.execCommand('insertHTML', false, payload.html);
        await sleep(400);

        if (!inserted || canvas.innerHTML === before) {
          await pasteInto(canvas, htmlToPlainText(payload.html), payload.html);
        }
        return { ok: true, result: { done: true } };
      }

      case 'insert-link': {
        const canvas = await waitFor(findCanvas, 15000);
        const headings = [...canvas.querySelectorAll('h2')];
        const heading = headings[payload.headingIndex];
        if (!heading) throw new Error('раздел не найден на полотне');

        // Ссылку ставим сразу за последней непустой строкой раздела
        const end = sectionEnd(canvas, heading, true);
        if (!end) throw new Error('не удалось определить конец раздела');

        caretAtEnd(canvas, end);
        await sleep(200);
        await pressEnter(canvas);
        // Ссылку вставляем обычным текстом: редактор сам превращает её в ссылку
        await pasteInto(canvas, payload.url, null);
        return { ok: true, result: { done: true } };
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
        const btn = await waitFor(() =>
          findByText('button.wizard-wrapper__action', 'Продолжить')
        );
        btn.click();
        await sleep(600);
        return { ok: true, result: { done: true } };
      }

      case 'notification': {
        const ta = await waitFor(() =>
          document.querySelector('.versioning-wrapper__notification textarea')
        );
        setNativeValue(ta, payload);
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

        const findNote = () =>
          document.querySelector(
            '.versioning-wrapper__notification textarea'
          ) ||
          [
            ...document.querySelectorAll(
              '.popup__container textarea, .wizard-wrapper textarea'
            ),
          ].find((t) => {
            const label = t.closest('div, label');
            const around = label ? label.textContent : '';
            return /уведомл/i.test(`${t.placeholder || ''} ${around}`);
          }) ||
          document.querySelector('.popup__container textarea');

        let note = findNote();
        let clicks = 0;

        while (!note && clicks < 8) {
          const next = findByText('button.wizard-wrapper__action', 'Продолжить');
          if (!next) break;
          if (next.disabled || next.className.includes('--disabled')) {
            await sleep(500);
            note = findNote();
            continue;
          }
          next.click();
          clicks += 1;
          await sleep(900);
          note = findNote();
        }

        if (!note) {
          throw new Error(
            `поле «Уведомление» не найдено в мастере публикации ` +
              `(шагов «Продолжить»: ${clicks})`
          );
        }

        // React иногда перерисовывает поле сразу после появления и сбрасывает
        // значение, поэтому пишем, проверяем и при необходимости повторяем.
        let value = '';
        for (let attempt = 0; attempt < 4; attempt += 1) {
          note.focus();
          setNativeValue(note, payload);
          note.dispatchEvent(new Event('blur', { bubbles: true }));
          await sleep(400);

          const live = findNote() || note;
          note = live;
          value = live.value;
          if (value === payload) break;
        }

        if (value !== payload) {
          throw new Error(
            `поле «Уведомление» не приняло текст (в поле осталось: «${value}»)`
          );
        }

        return { ok: true, result: { clicks, value } };
      }

      case 'finish': {
        const btn = await waitFor(() =>
          findByText('button.wizard-wrapper__action', 'Завершить')
        );
        btn.click();
        return { ok: true, result: { done: true } };
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

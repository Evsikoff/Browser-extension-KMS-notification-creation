'use strict';

// ============================================================================
// Тексты, которые уходят в поле «Уведомление» мастера публикации.
// Меняются здесь одним местом.
// ============================================================================

const NOTE_PAGE_CREATED = 'Первичное создание страницы нотификации';
const noteNotificationAdded = (title) => `Добавлено уведомление ${title}`;

// Предельное время ожидания редактора. Работа продолжается раньше — как
// только мастер увидит готовое полотно в фоновой вкладке.
const PACKAGE_WAIT_SECONDS = 180; // страницы пакетов открываются долго
const MAIN_PAGE_WAIT_SECONDS = 30; // головная страница — быстрее

// Кнопка «Завершить» в мастере публикации бывает неактивна ещё какое-то
// время после того, как заполнено поле «Уведомление»: KMS досчитывает
// изменения страницы. Это не ошибка — её надо переждать.
const FINISH_POLL_SECONDS = 10; // как часто перепроверяем кнопку
const FINISH_WAIT_SECONDS = 300; // сколько ждём, прежде чем спросить пользователя
const FINISH_LOG_SECONDS = 30; // как часто напоминаем в журнале, что ждём

// ============================================================================
// Состояние
// ============================================================================

const state = {
  config: null,
  // [{ name, subjects: [{ title, lastLine }] }] — структура головной страницы:
  // заголовки первого уровня дают пакеты, второго — темы.
  structure: [],
  checkRunId: 0,
  meta: null, // { packageName, subject, subjectLastLine, code, event, title }
  contentHtml: '',
  created: null, // { id, url, spaceId }
};

let editor = null;
let configDebounce = null;

// ============================================================================
// Элементы интерфейса
// ============================================================================

const ui = {
  steps: document.getElementById('steps'),

  authStatus: document.getElementById('authStatus'),
  authActions: document.getElementById('authActions'),
  authRetry: document.getElementById('authRetry'),

  checkStatus: document.getElementById('checkStatus'),
  structureTree: document.getElementById('structureTree'),
  configFold: document.getElementById('configFold'),
  configNote: document.getElementById('configNote'),
  mainPageUrl: document.getElementById('mainPageUrl'),
  packages: document.getElementById('packages'),
  addPackage: document.getElementById('addPackage'),
  resetConfig: document.getElementById('resetConfig'),
  recheck: document.getElementById('recheck'),
  toPhase3: document.getElementById('toPhase3'),

  metaPackage: document.getElementById('metaPackage'),
  metaSubject: document.getElementById('metaSubject'),
  metaSubjectLine: document.getElementById('metaSubjectLine'),
  metaCode: document.getElementById('metaCode'),
  metaEvent: document.getElementById('metaEvent'),
  backToPhase2: document.getElementById('backToPhase2'),
  toPhase4: document.getElementById('toPhase4'),

  editorTitleHint: document.getElementById('editorTitleHint'),
  backToPhase3: document.getElementById('backToPhase3'),
  resetTemplate: document.getElementById('resetTemplate'),
  toPhase5: document.getElementById('toPhase5'),

  workTitle: document.getElementById('workTitle'),
  workStatus: document.getElementById('workStatus'),
  timer: document.getElementById('workTimer'),
  timerValue: document.getElementById('workTimerValue'),
  prompt: document.getElementById('workPrompt'),
  promptText: document.getElementById('workPromptText'),
  promptButtons: document.getElementById('workPromptButtons'),
  picker: document.getElementById('workPicker'),
  pickerText: document.getElementById('workPickerText'),
  pickerSelect: document.getElementById('workPickerSelect'),
  pickerConfirm: document.getElementById('workPickerConfirm'),
  log: document.getElementById('log'),

  doneUrl: document.getElementById('doneUrl'),
  copyUrl: document.getElementById('copyUrl'),
  another: document.getElementById('another'),
  doneLog: document.getElementById('doneLog'),
};

// ============================================================================
// Общие помощники интерфейса
// ============================================================================

function showPhase(id, step) {
  document
    .querySelectorAll('.phase')
    .forEach((s) => s.classList.toggle('is-visible', s.id === id));

  [...ui.steps.children].forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('is-active', n === step);
    li.classList.toggle('is-done', n < step);
  });

  window.scrollTo({ top: 0 });
}

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = 'status' + (kind ? ` is-${kind}` : '');
}

function log(message) {
  const time = new Date().toLocaleTimeString('ru-RU');
  ui.log.textContent += `${ui.log.textContent ? '\n' : ''}[${time}] ${message}`;
  ui.log.scrollTop = ui.log.scrollHeight;
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ask(text, options) {
  return new Promise((resolve) => {
    ui.promptText.textContent = text;
    ui.promptButtons.innerHTML = '';
    ui.prompt.hidden = false;

    for (const option of options) {
      const button = document.createElement('button');
      button.className = 'btn' + (option.primary ? ' btn-primary' : '');
      button.textContent = option.label;
      button.addEventListener('click', () => {
        ui.prompt.hidden = true;
        resolve(option.value);
      });
      ui.promptButtons.appendChild(button);
    }
  });
}

// Опрашиваем фоновую вкладку, пока в ней не появится готовое полотно
// редактора. Отсчёт показываем как предельное время ожидания, но обычно
// работа продолжается раньше — как только редактор отрисовался.
async function waitEditorReady(tabId, seconds) {
  ui.timer.hidden = false;

  const startedAt = Date.now();
  let hits = 0;

  const tick = setInterval(() => {
    const left = Math.max(
      0,
      seconds - Math.round((Date.now() - startedAt) / 1000)
    );
    ui.timerValue.textContent = fmtTime(left);
  }, 500);
  ui.timerValue.textContent = fmtTime(seconds);

  try {
    while (Date.now() - startedAt < seconds * 1000) {
      let ready = false;
      try {
        ready = (await exec(tabId, 'canvas-check')).ready;
      } catch (e) {
        ready = false; // вкладка ещё грузится
      }

      // Два попадания подряд: полотно бывает готово раньше содержимого
      hits = ready ? hits + 1 : 0;
      if (hits >= 2) return 'ready';

      await sleep(1500);
    }
    return 'timeout';
  } finally {
    clearInterval(tick);
    ui.timer.hidden = true;
  }
}

function pickSection(text, headings, defaultIndex) {
  return new Promise((resolve) => {
    ui.pickerText.textContent = text;
    ui.pickerSelect.innerHTML = '';

    for (const heading of headings) {
      const option = document.createElement('option');
      option.value = String(heading.index);
      option.textContent = heading.text || '(заголовок без текста)';
      ui.pickerSelect.appendChild(option);
    }

    ui.pickerSelect.value = String(defaultIndex);
    ui.picker.hidden = false;

    ui.pickerConfirm.onclick = () => {
      ui.picker.hidden = true;
      resolve(Number(ui.pickerSelect.value));
    };
  });
}

// ============================================================================
// Сравнение текстов
// ============================================================================

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Триграммы, а не отдельные слова: так «акцепты» и «акцептов» остаются
// похожими, что важно для русских окончаний.
function trigrams(value) {
  const padded = `  ${normalizeText(value)} `;
  const result = new Set();
  for (let i = 0; i < padded.length - 2; i += 1) {
    result.add(padded.slice(i, i + 3));
  }
  return result;
}

function similarity(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;

  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let common = 0;
  for (const gram of setA) if (setB.has(gram)) common += 1;
  return (2 * common) / (setA.size + setB.size);
}

// ============================================================================
// Фаза 1. Проверка авторизации
// ============================================================================

async function checkAuthorization() {
  showPhase('phase-1', 1);
  setStatus(ui.authStatus, 'Проверка авторизации…');
  ui.authActions.hidden = true;

  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: AUTH_PROBE_URL, active: false });
    await waitTabComplete(tab.id);
    const { authorized } = await exec(tab.id, 'auth');
    await closeTabQuietly(tab.id);
    tab = null;

    if (!authorized) {
      setStatus(
        ui.authStatus,
        'В Naumen KMS нет активной сессии. Закройте вкладку мастера, ' +
          'войдите в KMS и запустите мастер заново.',
        'err'
      );
      ui.authActions.hidden = false;
      return;
    }
  } catch (e) {
    if (tab) await closeTabQuietly(tab.id);
    setStatus(ui.authStatus, `Проверить авторизацию не удалось: ${e.message}`, 'err');
    ui.authActions.hidden = false;
    return;
  }

  await startConfiguration();
}

// ============================================================================
// Фаза 2. Конфигурация и проверки
// ============================================================================

function packageMarkup(pkg, index) {
  const wrap = document.createElement('div');
  wrap.className = 'package';
  wrap.innerHTML = `
    <div class="package__head">
      <label class="field">
        <span class="field__label">Наименование пакета</span>
        <input type="text" data-field="name">
      </label>
      <button class="btn btn-danger" data-remove>Удалить</button>
    </div>
    <div class="package__grid">
      <label class="field">
        <span class="field__label">Адрес просмотра</span>
        <input type="text" data-field="viewUrl">
      </label>
      <label class="field">
        <span class="field__label">Адрес редактирования</span>
        <input type="text" data-field="editUrl">
      </label>
      <label class="field">
        <span class="field__label">Адрес создания дочерней страницы</span>
        <input type="text" data-field="createChildUrl">
      </label>
    </div>`;

  wrap.querySelector('[data-field="name"]').value = pkg.name;
  wrap.querySelector('[data-field="viewUrl"]').value = pkg.viewUrl;
  wrap.querySelector('[data-field="editUrl"]').value = pkg.editUrl;
  wrap.querySelector('[data-field="createChildUrl"]').value = pkg.createChildUrl;

  wrap.querySelector('[data-remove]').addEventListener('click', () => {
    state.config = readConfigFromForm();
    state.config.packages.splice(index, 1);
    renderConfig();
    onConfigChanged();
  });

  return wrap;
}

function renderConfig() {
  ui.mainPageUrl.value = state.config.mainPageUrl;
  ui.packages.innerHTML = '';
  state.config.packages.forEach((pkg, i) => {
    ui.packages.appendChild(packageMarkup(pkg, i));
  });
  ui.configNote.textContent = `— пакетов: ${state.config.packages.length}`;
}

// Настройки свёрнуты, пока всё сходится. Разворачиваем их сами, когда
// проверка упёрлась в конфигурацию: иначе «поправьте в настройках ниже»
// указывает на скрытый блок.
function failCheck(text) {
  setStatus(ui.checkStatus, text, 'err');
  ui.configFold.open = true;
}

function readConfigFromForm() {
  return {
    mainPageUrl: ui.mainPageUrl.value.trim(),
    packages: [...ui.packages.querySelectorAll('.package')].map((node) => ({
      name: node.querySelector('[data-field="name"]').value.trim(),
      viewUrl: node.querySelector('[data-field="viewUrl"]').value.trim(),
      editUrl: node.querySelector('[data-field="editUrl"]').value.trim(),
      createChildUrl: node
        .querySelector('[data-field="createChildUrl"]')
        .value.trim(),
    })),
  };
}

// Любая правка настроек останавливает текущую проверку; через паузу
// настройки сохраняются и проверка запускается заново.
function onConfigChanged() {
  state.checkRunId += 1; // отменяем всё, что сейчас выполняется
  state.structure = [];
  ui.toPhase3.disabled = true;
  ui.structureTree.hidden = true;
  setStatus(ui.checkStatus, 'Настройки изменены — проверка остановлена.', 'warn');

  clearTimeout(configDebounce);
  configDebounce = setTimeout(async () => {
    state.config = readConfigFromForm();
    await saveConfig(state.config);
    runStructureCheck();
  }, 900);
}

async function startConfiguration() {
  state.config = await loadConfig();
  renderConfig();
  showPhase('phase-2', 2);
  runStructureCheck();
}

function renderStructure() {
  ui.structureTree.innerHTML = '';
  for (const pack of state.structure) {
    const packNode = document.createElement('div');
    packNode.className = 'tree__pack';
    packNode.textContent = `${pack.name} — тем: ${pack.subjects.length}`;
    ui.structureTree.appendChild(packNode);

    for (const subject of pack.subjects) {
      const subjectNode = document.createElement('div');
      subjectNode.className = 'tree__subject';
      subjectNode.textContent = subject.lastLine
        ? `${subject.title} — последняя строка: ${subject.lastLine}`
        : `${subject.title} — раздел пуст`;
      ui.structureTree.appendChild(subjectNode);
    }
  }
  ui.structureTree.hidden = false;
}

async function runStructureCheck() {
  const runId = ++state.checkRunId;
  const aborted = () => runId !== state.checkRunId;

  ui.toPhase3.disabled = true;
  ui.structureTree.hidden = true;
  setStatus(ui.checkStatus, 'Читаю головную страницу клиентских нотификаций…');

  if (!state.config.mainPageUrl) {
    failCheck('Укажите адрес головной страницы.');
    return;
  }
  if (state.config.packages.length === 0) {
    failCheck('Добавьте хотя бы один пакет уведомлений.');
    return;
  }

  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: state.config.mainPageUrl, active: false });
    await waitTabComplete(tab.id);
    if (aborted()) return;

    const { packs, orphanSubjects, ignored } = await exec(
      tab.id,
      'scan-structure'
    );
    if (aborted()) return;

    if (packs.length === 0) {
      failCheck(
        'На головной странице нет заголовков первого уровня — пакеты ' +
          'определить не из чего. Проверьте адрес головной страницы в ' +
          'настройках ниже.'
      );
      return;
    }

    // Сверяем заголовки первого уровня с наименованиями пакетов
    const missing = [];
    const matched = new Map(); // имя пакета из конфигурации → индекс заголовка

    state.config.packages.forEach((pkg) => {
      const index = packs.findIndex(
        (p) => normalizeText(p.text) === normalizeText(pkg.name)
      );
      if (index === -1) missing.push(pkg.name);
      else matched.set(pkg.name, index);
    });

    if (missing.length > 0) {
      failCheck(
        'На головной странице не найдены пакеты: ' +
          missing.join('; ') +
          '. Найдено на странице: ' +
          packs.map((p) => p.text).join('; ') +
          '. Поправьте наименования в настройках ниже.'
      );
      return;
    }

    if (packs.every((p) => p.subjects.length === 0)) {
      failCheck(
        'На головной странице нет заголовков второго уровня — темы ' +
          'уведомлений определить не из чего.'
      );
      return;
    }

    state.structure = state.config.packages.map((pkg) => ({
      name: pkg.name,
      subjects: (packs[matched.get(pkg.name)].subjects || []).map((s) => ({
        title: s.text,
        lastLine: s.lastLine,
      })),
    }));

    const notes = [];
    const extra = packs
      .map((p) => p.text)
      .filter(
        (text) =>
          !state.config.packages.some(
            (p) => normalizeText(p.name) === normalizeText(text)
          )
      );
    if (extra.length > 0) {
      notes.push(`пакеты со страницы вне настроек: ${extra.join('; ')}`);
    }
    if (orphanSubjects > 0) {
      notes.push(`тем выше первого пакета: ${orphanSubjects} (не учтены)`);
    }
    if (ignored.headings.length > 0) {
      notes.push(
        `пропущены служебные заголовки: ${ignored.headings.join('; ')}` +
          (ignored.subjects > 0 ? ` (тем внутри: ${ignored.subjects})` : '')
      );
    }
    const empty = state.structure.filter((p) => p.subjects.length === 0);
    if (empty.length > 0) {
      notes.push(`без тем: ${empty.map((p) => p.name).join('; ')}`);
    }
    const blank = state.structure
      .flatMap((p) => p.subjects)
      .filter((s) => !s.lastLine);
    if (blank.length > 0) {
      notes.push(`тем без строк: ${blank.map((s) => s.title).join('; ')}`);
    }

    setStatus(
      ui.checkStatus,
      `Структура собрана: пакетов ${state.structure.length}, тем ` +
        `${state.structure.reduce((s, p) => s + p.subjects.length, 0)}.` +
        (notes.length ? ' Обратите внимание: ' + notes.join('; ') + '.' : ''),
      notes.length ? 'warn' : 'ok'
    );

    renderStructure();
    ui.toPhase3.disabled = false;
  } catch (e) {
    if (!aborted()) {
      failCheck(`Проверка не выполнена: ${e.message}`);
    }
  } finally {
    if (tab) await closeTabQuietly(tab.id);
  }
}

// ============================================================================
// Фаза 3. Метаданные
// ============================================================================

function fillPackageSelect() {
  ui.metaPackage.innerHTML = '<option value="">— выберите пакет —</option>';
  for (const pack of state.structure) {
    const option = document.createElement('option');
    option.value = pack.name;
    option.textContent = pack.name;
    ui.metaPackage.appendChild(option);
  }
  ui.metaSubject.innerHTML = '';
  ui.metaSubject.disabled = true;
}

function fillSubjectSelect() {
  const pack = state.structure.find((p) => p.name === ui.metaPackage.value);
  ui.metaSubject.innerHTML = '<option value="">— выберите тему —</option>';

  if (!pack) {
    ui.metaSubject.disabled = true;
    showSubjectLastLine();
    return;
  }

  for (const subject of pack.subjects) {
    const option = document.createElement('option');
    option.value = subject.title;
    option.textContent = subject.title;
    ui.metaSubject.appendChild(option);
  }
  ui.metaSubject.disabled = pack.subjects.length === 0;
  showSubjectLastLine();
}

// Тема, выбранная в фазе 3, вместе с прочитанной на головной странице
// последней непустой строкой её раздела.
function currentSubject() {
  const pack = state.structure.find((p) => p.name === ui.metaPackage.value);
  if (!pack) return null;
  return pack.subjects.find((s) => s.title === ui.metaSubject.value) || null;
}

// Последняя строка темы — ориентир: за ней встанет ссылка в фазе 7.
function showSubjectLastLine() {
  const subject = currentSubject();

  if (!subject) {
    ui.metaSubjectLine.textContent = '';
    ui.metaSubjectLine.hidden = true;
    return;
  }

  ui.metaSubjectLine.textContent = subject.lastLine
    ? `Последняя строка темы на головной странице: «${subject.lastLine}».`
    : 'В этой теме на головной странице нет непустых строк.';
  ui.metaSubjectLine.hidden = false;
}

function validateMeta() {
  const ready =
    ui.metaPackage.value &&
    ui.metaSubject.value &&
    ui.metaCode.value.trim() &&
    ui.metaEvent.value.trim();
  ui.toPhase4.disabled = !ready;
}

function goToMeta() {
  fillPackageSelect();
  ui.metaCode.value = '';
  ui.metaEvent.value = '';
  showSubjectLastLine();
  validateMeta();
  showPhase('phase-3', 3);
}

// ============================================================================
// Фаза 4. Содержание
// ============================================================================

function currentPackage() {
  return state.config.packages.find((p) => p.name === state.meta.packageName);
}

function goToContent() {
  const subject = currentSubject();

  state.meta = {
    packageName: ui.metaPackage.value,
    subject: ui.metaSubject.value,
    subjectLastLine: subject ? subject.lastLine : '',
    code: ui.metaCode.value.trim(),
    event: ui.metaEvent.value.trim(),
  };
  state.meta.title = `${state.meta.code} ${state.meta.event}`;

  ui.editorTitleHint.textContent =
    `Название страницы: «${state.meta.title}». ` +
    `Пакет: ${state.meta.packageName}. Тема: ${state.meta.subject}.`;

  editor.setHtml(buildNotificationTemplate({ eventText: state.meta.event }));

  showPhase('phase-4', 4);
}

// ============================================================================
// Фазы 5–7. Автоматическая работа со страницами KMS
// ============================================================================

// Ждём, пока кнопка «Завершить» станет активной. Опрашиваем мастер раз в
// FINISH_POLL_SECONDS секунд и пишем в журнал, чего именно ждём: молчаливая
// пауза выглядит как зависание расширения.
// Возвращает 'ready' | 'closed' | 'timeout'.
async function waitForFinishButton(tabId, note, seconds) {
  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

  let reported = ''; // чтобы не повторять в журнале одно и то же
  let lastLogAt = 0;
  let checks = 0;
  let repairs = 0;

  ui.timer.hidden = false;
  const tick = setInterval(() => {
    ui.timerValue.textContent = fmtTime(Math.max(0, seconds - elapsed()));
  }, 500);
  ui.timerValue.textContent = fmtTime(seconds);

  try {
    while (elapsed() < seconds) {
      const state = await exec(tabId, 'wizard-state');
      checks += 1;

      if (!state.open) return 'closed';

      // Кнопка активна — либо мастер стоит на промежуточном шаге, дальше
      // его проведёт сам шаг завершения.
      if (state.finish && !state.finish.disabled) {
        if (checks > 1) {
          log(
            `Кнопка «${state.finish.label}» стала активной через ` +
              `${fmtTime(elapsed())} (проверок: ${checks}).`
          );
        }
        return 'ready';
      }
      if (!state.finish && state.next && !state.next.disabled) return 'ready';

      // Текст уведомления мог слететь при перерисовке — вписываем заново,
      // иначе кнопка не включится никогда. Больше трёх попыток не делаем:
      // если поле упорно показывает своё, дальше просто ждём и не засоряем
      // журнал одинаковыми строками.
      if (state.note && note && state.note.value !== note && repairs < 3) {
        repairs += 1;
        log(
          `Текст уведомления пропал из поля — вписываю заново ` +
            `(попытка ${repairs} из 3).`
        );
        try {
          await exec(tabId, 'publish-wizard', note);
        } catch (e) {
          log(`Вписать текст уведомления не удалось: ${e.message}. Жду дальше.`);
        }
      }

      const what = state.finish
        ? `кнопка «${state.finish.label}» пока неактивна`
        : `кнопка «Завершить» ещё не появилась (в окне: ${state.buttons})`;

      setStatus(
        ui.workStatus,
        `Мастер публикации открыт, ${what}. Жду и перепроверяю каждые ` +
          `${FINISH_POLL_SECONDS} секунд — уже ${fmtTime(elapsed())}. ` +
          'Закрывать окно и нажимать что-либо вручную не нужно.'
      );

      // В журнал пишем при первом обнаружении и потом изредка, чтобы было
      // видно, что мастер жив, но журнал не заплывал одинаковыми строками.
      if (what !== reported) {
        log(
          `Мастер публикации: ${what}. Жду, перепроверяю каждые ` +
            `${FINISH_POLL_SECONDS} секунд.`
        );
        reported = what;
        lastLogAt = elapsed();
      } else if (elapsed() - lastLogAt >= FINISH_LOG_SECONDS) {
        log(`Всё ещё жду: ${what} (${fmtTime(elapsed())}, проверок: ${checks}).`);
        lastLogAt = elapsed();
      }

      await sleep(FINISH_POLL_SECONDS * 1000);
    }
    return 'timeout';
  } finally {
    clearInterval(tick);
    ui.timer.hidden = true;
  }
}

// Завершение мастера публикации: сначала дожидаемся активной кнопки, потом
// нажимаем. Если кнопка так и не ожила — спрашиваем пользователя, ждать ли
// дальше, а не падаем с ошибкой сразу.
async function finishWizard(tabId, note) {
  let failures = 0;
  let reason = '';

  while (true) {
    const state = await waitForFinishButton(tabId, note, FINISH_WAIT_SECONDS);

    if (state === 'closed') {
      log('Мастер публикации закрылся сам.');
      return;
    }

    if (state === 'ready') {
      try {
        const finished = await exec(tabId, 'finish', { note });
        log(
          finished.closed
            ? 'Мастер публикации закрылся сам.'
            : `Нажата кнопка «${finished.clicked}»` +
                (finished.advanced
                  ? ` (перед ней пришлось пройти ещё шагов: ${finished.advanced}).`
                  : '.')
        );
        return;
      } catch (e) {
        // Кнопка успела снова стать неактивной — это не повод падать,
        // возвращаемся к ожиданию.
        failures += 1;
        reason = e.message;
        log(`Нажатие не прошло: ${e.message}.`);
        if (failures < 3) {
          log('Возвращаюсь к ожиданию активной кнопки.');
          continue;
        }
      }
    } else {
      reason = `кнопка не стала активной за ${fmtTime(FINISH_WAIT_SECONDS)}`;
    }

    log(`Мастер публикации не завершён (${reason}) — спрашиваю, что делать.`);

    const answer = await ask(
      `Мастер публикации не удалось завершить: ${reason}. Окно мастера ` +
        'открыто в фоновой вкладке — публикацию можно завершить там вручную. ' +
        'Что делаем?',
      [
        { label: 'Подождать ещё', value: 'wait', primary: true },
        { label: 'Прекратить ожидание', value: 'stop' },
      ]
    );

    if (answer === 'stop') throw new Error(reason);

    failures = 0;
    log('Жду кнопку «Завершить» дальше.');
  }
}

// Публикация новой страницы (фаза 5): последовательность проверена
// на форме создания.
async function publishFlow(tabId, note) {
  await exec(tabId, 'publish');
  await exec(tabId, 'modal-nav');
  for (let i = 0; i < 3; i += 1) await exec(tabId, 'continue');
  await exec(tabId, 'notification', note);
  await finishWizard(tabId, note);
}

// Публикация изменений существующей страницы (фазы 6 и 7): число шагов
// мастера здесь другое, поэтому идём до поля «Уведомление» и проверяем,
// что текст в нём удержался.
async function publishExistingPage(tabId, note) {
  await exec(tabId, 'publish');
  const result = await exec(tabId, 'publish-wizard', note);
  log(
    `Поле «Уведомление» заполнено: «${result.value}» ` +
      `(шагов «Продолжить»: ${result.clicks}). Кнопки окна: ${result.buttons}.`
  );

  await finishWizard(tabId, note);
  await exec(tabId, 'wizard-closed');
}

// Ждём готовности редактора в фоновой вкладке. Фокус остаётся на мастере:
// переключаться на вкладку KMS и возвращаться обратно не нужно.
async function waitForEditorTab(tabId, what, seconds) {
  while (true) {
    setStatus(
      ui.workStatus,
      `Открываю ${what} в режиме редактирования — вкладка загружается в ` +
        'фоне. Оставайтесь здесь: мастер сам увидит, что редактор готов, ' +
        'и продолжит работу.'
    );

    const result = await waitEditorReady(tabId, seconds);

    if (result === 'ready') {
      await sleep(1500); // даём странице дорисоваться после появления полотна
      log(`${capitalize(what)}: редактор готов.`);
      return;
    }

    const answer = await ask(
      `${capitalize(what)} за ${fmtTime(seconds)} так и не открылась в ` +
        'режиме редактирования. Что делаем?',
      [
        { label: 'Подождать ещё', value: 'wait', primary: true },
        { label: 'Перезагрузить страницу', value: 'reload' },
      ]
    );

    if (answer === 'reload') {
      log('Перезагружаю страницу.');
      await chrome.tabs.reload(tabId);
    }
  }
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Вставка идёт только в фоновой вкладке: фокус пользователя мастер никуда
// не уводит. Если редактор не принял вставку с первого раза — повторяем на
// той же вкладке, дав странице дорисоваться.
async function insertInBackground(tabId, step, payload) {
  try {
    return await exec(tabId, step, payload);
  } catch (e) {
    // Если испорченную вставку не удалось отменить, повтор добавит вторую
    // такую же — решение отдаём пользователю сразу.
    if (/отменить вставку не удалось/i.test(e.message)) throw e;
    log(`Вставка не прошла (${e.message}). Повторяю на той же вкладке.`);
  }

  await sleep(1500);
  return exec(tabId, step, payload);
}

// Выбор раздела: подставляем самый похожий на тему заголовок, пользователь
// подтверждает или выбирает другой.
async function chooseSection(tabId, what) {
  const { headings } = await exec(tabId, 'headings');
  if (headings.length === 0) {
    throw new Error(`на ${what} нет заголовков второго уровня`);
  }

  let best = 0;
  let bestScore = -1;
  headings.forEach((heading, i) => {
    const score = similarity(heading.text, state.meta.subject);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });

  log(
    `Наиболее близкий раздел: «${headings[best].text}» ` +
      `(совпадение ${Math.round(bestScore * 100)}%).`
  );

  return pickSection(
    `Тема уведомления: «${state.meta.subject}». Вставляем в конец раздела:`,
    headings,
    headings[best].index
  );
}

// Раздел головной страницы: пакеты — заголовки первого уровня, темы —
// второго, поэтому тему ищем внутри выбранного пакета.
async function chooseMainPageSection(tabId) {
  const { sections } = await exec(tabId, 'outline');
  if (sections.length === 0) {
    throw new Error('на головной странице нет заголовков второго уровня');
  }

  const inPack = sections.filter(
    (s) => normalizeText(s.pack) === normalizeText(state.meta.packageName)
  );
  if (inPack.length === 0) {
    log(
      `Пакет «${state.meta.packageName}» не найден среди заголовков первого ` +
        'уровня — ищу тему по всей странице.'
    );
  }

  const pool = inPack.length > 0 ? inPack : sections;
  let best = pool[0];
  let bestScore = -1;
  for (const section of pool) {
    const score = similarity(section.text, state.meta.subject);
    if (score > bestScore) {
      bestScore = score;
      best = section;
    }
  }

  log(
    `Наиболее близкая тема: «${best.text}» ` +
      `(совпадение ${Math.round(bestScore * 100)}%).`
  );

  const lastLine = state.meta.subjectLastLine
    ? ` Ссылка встанет за последней строкой темы: «${state.meta.subjectLastLine}».`
    : '';

  return pickSection(
    `Тема уведомления: «${state.meta.subject}». Вставляем в конец темы:` +
      lastLine,
    sections.map((s) => ({
      index: s.index,
      text: s.pack ? `${s.pack} → ${s.text}` : s.text,
    })),
    best.index
  );
}

// ------------------------------------------------------------------ фаза 5

async function phaseCreatePage() {
  showPhase('phase-work', 5);
  ui.workTitle.textContent = 'Фаза 5. Создание страницы уведомления';
  setStatus(
    ui.workStatus,
    'Создаю страницу уведомления. Нажимать ничего не нужно — ' +
      'мастер сам заполнит поля и опубликует страницу.'
  );

  const pkg = currentPackage();
  const html = state.contentHtml;
  const text = editor.getText();

  const tab = await chrome.tabs.create({ url: pkg.createChildUrl, active: false });
  log('Открыта форма создания дочерней страницы (в фоновой вкладке).');

  await waitTabComplete(tab.id);
  await exec(tab.id, 'canvas'); // ждём полотно, а не фиксированную паузу
  await sleep(1500); // даём SPA дорисоваться после появления полотна

  try {
    await exec(tab.id, 'fullwidth');
  } catch (e) {
    log(`Кнопка «на всю ширину» недоступна (${e.message}) — продолжаю.`);
  }

  await exec(tab.id, 'title', state.meta.title);
  log(`Название задано: «${state.meta.title}».`);

  await insertInBackground(tab.id, 'content', { html, text });
  log('Содержание вставлено на полотно.');

  const urlBeforeFinish = (await chrome.tabs.get(tab.id)).url || '';
  const ignoreIds = new Set([
    ...wikiIdsIn(pkg.viewUrl),
    ...wikiIdsIn(pkg.createChildUrl),
    ...wikiIdsIn(urlBeforeFinish),
  ]);

  await publishFlow(tab.id, NOTE_PAGE_CREATED);
  log('Страница отправлена на публикацию.');

  const { id, url } = await waitForPageId(tab.id, ignoreIds);
  state.created = {
    id,
    url: toViewUrl(url) || url,
    spaceId: spaceIdIn(url) || spaceIdIn(pkg.viewUrl),
  };
  log(`Страница создана: ${state.created.url}`);

  await closeTabQuietly(tab.id);
}

// ------------------------------------------------------------------ фаза 6

function layoutHtml({ leftText, articleId, spaceId }) {
  const safeText = escapeHtml(leftText);
  return (
    '<div class="m-grid m-grid--aside-left">' +
    '<div class="m-grid__aside m-grid__aside-sLeft" role="textbox" ' +
    'data-grid-column="1" aria-multiline="true">' +
    '<div style="height: 100%; cursor: text; padding: 5px;">' +
    `<p style="">${safeText}</p></div></div>` +
    '<div class="m-grid__column m-grid__column-center" role="textbox" ' +
    'data-grid-column="1" aria-multiline="true">' +
    '<div style="height: 100%; cursor: text; padding: 5px;">' +
    `<div class="m-embedded" data-article-id="${articleId}" ` +
    `data-article-space-id="${spaceId}" data-is-show-link-content="true" ` +
    'data-is-show-all-content="true" data-is-show-field-name="true" ' +
    'contenteditable="false" draggable="true"><div></div></div>' +
    '</div></div></div>'
  );
}

async function phaseAddLayout() {
  showPhase('phase-work', 6);
  ui.workTitle.textContent = 'Фаза 6. Макет уведомления на странице пакета';

  const pkg = currentPackage();
  const tab = await chrome.tabs.create({ url: pkg.editUrl, active: false });
  log(`Открываю страницу пакета «${pkg.name}» на редактирование.`);

  await waitForEditorTab(tab.id, 'страница пакета', PACKAGE_WAIT_SECONDS);
  setStatus(ui.workStatus, 'Выберите раздел, в конец которого добавить макет.');

  const headingIndex = await chooseSection(tab.id, 'странице пакета');

  setStatus(ui.workStatus, 'Добавляю макет и публикую страницу пакета.');
  const added = await insertInBackground(tab.id, 'insert-html', {
    headingIndex,
    html: layoutHtml({
      leftText: state.meta.title,
      articleId: state.created.id,
      spaceId: state.created.spaceId,
    }),
  });
  log(
    `Макет добавлен в конец раздела: ${added.where}; ` +
      `в разделе он ${added.position}` +
      (added.moved
        ? added.wrong
          ? ` (редактор поставил его ${added.wrong} — перенёс в конец).`
          : ' (перенёс в конец раздела).'
        : '.')
  );

  await publishExistingPage(tab.id, noteNotificationAdded(state.meta.title));
  log('Страница пакета опубликована.');

  await closeTabQuietly(tab.id);
}

// ------------------------------------------------------------------ фаза 7

async function phaseAddLink() {
  showPhase('phase-work', 7);
  ui.workTitle.textContent = 'Фаза 7. Ссылка на головной странице';

  const editUrl = toEditUrl(state.config.mainPageUrl);
  if (!editUrl) {
    throw new Error(
      'из адреса головной страницы не удалось получить адрес редактирования'
    );
  }

  const tab = await chrome.tabs.create({ url: editUrl, active: false });
  log('Открываю головную страницу на редактирование.');

  await waitForEditorTab(tab.id, 'головная страница', MAIN_PAGE_WAIT_SECONDS);
  setStatus(ui.workStatus, 'Выберите тему, в конец которой добавить ссылку.');

  const headingIndex = await chooseMainPageSection(tab.id);

  setStatus(ui.workStatus, 'Добавляю ссылку и публикую головную страницу.');
  const added = await insertInBackground(tab.id, 'insert-link', {
    headingIndex,
    url: state.created.url,
  });
  log(`Ссылка добавлена в конец раздела: ${added.where}.`);

  await publishExistingPage(tab.id, noteNotificationAdded(state.meta.title));
  log('Головная страница опубликована.');

  await closeTabQuietly(tab.id);
}

// ------------------------------------------------------- запуск фаз 5–7

async function runStage(name, fn) {
  while (true) {
    try {
      await fn();
      return;
    } catch (e) {
      log(`ОШИБКА. ${name}: ${e.message}`);
      const answer = await ask(
        `Шаг «${name}» не завершён: ${e.message}. Вкладка оставлена открытой — ` +
          'можно доделать вручную.',
        [
          { label: 'Повторить шаг', value: 'retry', primary: true },
          { label: 'Продолжить дальше', value: 'skip' },
          { label: 'Остановить мастер', value: 'stop' },
        ]
      );
      if (answer === 'stop') throw e;
      if (answer === 'skip') return;
    }
  }
}

async function runPipeline() {
  state.contentHtml = editor.getHtml();
  ui.log.textContent = '';

  try {
    await runStage('Создание страницы уведомления', phaseCreatePage);
    if (!state.created) {
      throw new Error('страница уведомления не создана, дальше идти незачем');
    }
    await runStage('Добавление макета на страницу пакета', phaseAddLayout);
    await runStage('Добавление ссылки на головную страницу', phaseAddLink);
    showDone();
  } catch (e) {
    setStatus(ui.workStatus, `Мастер остановлен: ${e.message}`, 'err');
  }
}

// ============================================================================
// Финал
// ============================================================================

function showDone() {
  ui.doneUrl.value = state.created ? state.created.url : '';
  ui.doneLog.textContent = ui.log.textContent;
  showPhase('phase-done', 7);
}

// ============================================================================
// События
// ============================================================================

ui.authRetry.addEventListener('click', checkAuthorization);

ui.mainPageUrl.addEventListener('input', onConfigChanged);
ui.packages.addEventListener('input', onConfigChanged);

ui.addPackage.addEventListener('click', () => {
  state.config = readConfigFromForm();
  state.config.packages.push({
    name: '',
    viewUrl: '',
    editUrl: '',
    createChildUrl: '',
  });
  renderConfig();
  onConfigChanged();
});

ui.resetConfig.addEventListener('click', async () => {
  state.config = cloneDefaultConfig();
  await saveConfig(state.config);
  renderConfig();
  runStructureCheck();
});

ui.recheck.addEventListener('click', async () => {
  state.config = readConfigFromForm();
  await saveConfig(state.config);
  runStructureCheck();
});

ui.toPhase3.addEventListener('click', goToMeta);

ui.metaPackage.addEventListener('change', () => {
  fillSubjectSelect(); // смена пакета очищает тему
  validateMeta();
});
ui.metaSubject.addEventListener('change', showSubjectLastLine);
['change', 'input'].forEach((event) => {
  ui.metaSubject.addEventListener(event, validateMeta);
  ui.metaCode.addEventListener(event, validateMeta);
  ui.metaEvent.addEventListener(event, validateMeta);
});

ui.backToPhase2.addEventListener('click', () => showPhase('phase-2', 2));
ui.toPhase4.addEventListener('click', goToContent);

ui.backToPhase3.addEventListener('click', () => showPhase('phase-3', 3));
ui.resetTemplate.addEventListener('click', () => {
  editor.setHtml(buildNotificationTemplate({ eventText: state.meta.event }));
});
ui.toPhase5.addEventListener('click', runPipeline);

ui.copyUrl.addEventListener('click', async () => {
  await navigator.clipboard.writeText(ui.doneUrl.value);
});

ui.another.addEventListener('click', () => {
  state.meta = null;
  state.created = null;
  goToMeta();
});

// ============================================================================
// Старт
// ============================================================================

editor = new SimpleEditor(document.getElementById('editor'));
checkAuthorization();

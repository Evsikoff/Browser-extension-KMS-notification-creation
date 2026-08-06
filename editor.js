'use strict';

// ============================================================================
// Шаблон страницы уведомления
// ============================================================================

const BODY_STYLE =
  "line-height:normal;margin-top:0pt;margin-bottom:0pt;border:none;" +
  "mso-border-left-alt:none;mso-border-top-alt:none;mso-border-right-alt:none;" +
  "mso-border-bottom-alt:none;mso-border-between:none";

const SPAN_STYLE =
  "font-family:'Liberation Sans';font-size:11pt;color:#000000;" +
  'mso-style-textfill-fill-color:#000000';

const ATTRS_LINK_URL =
  'https://kms.headoffice.psbank.local/content/space/2198/wiki/598825';
const ATTRS_LINK_TEXT =
  'Экранная форма и атрибутный состав Заявления (параметры Уведомления)';

// Разделы шаблона, кроме последнего: [заголовок, содержимое]
const TEMPLATE_SECTIONS = [
  'Событие',
  'Адресат',
  'Шаблон текста',
  'Шаблон SMS для операторов связи',
  'Порядок направления уведомления',
  'ID (поле для разработчиков)',
  'Дополнительная информация',
  'Доступные каналы рассылки',
];

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function templateParagraph(content) {
  // Пустое место оставляем как <br> внутри span: строка остаётся редактируемой
  const inner = content ? escapeHtml(content) : '<br>';
  return (
    `<div><p style="${BODY_STYLE}">` +
    `<span style="${SPAN_STYLE}">${inner}</span></p></div>`
  );
}

function templateSection(title, content) {
  return (
    `<div><b><u>${escapeHtml(title)}</u></b></div>` +
    templateParagraph(content) +
    '<br>'
  );
}

// Содержимое редактора фазы 4 (тело шаблона без html/head/title)
function buildNotificationTemplate({ eventText }) {
  let html = '';

  for (const title of TEMPLATE_SECTIONS) {
    html += templateSection(title, title === 'Событие' ? eventText : '');
  }

  html +=
    '<div><b><u>Дополнительный параметр для события</u></b></div>' +
    '<div>' +
    `<p><em>Атрибуты 13 и 15 описаны в ТЗ "</em>` +
    `<a href="${ATTRS_LINK_URL}" rel="noopener noreferrer nofollow" ` +
    `class="m-app-link">${ATTRS_LINK_TEXT}</a><em>"</em></p>` +
    `<p style="${BODY_STYLE}"><span style="${SPAN_STYLE}"><br></span></p>` +
    '</div><br>';

  return html;
}

// ============================================================================
// Визуальный редактор
// ============================================================================

class SimpleEditor {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector('[data-editor-canvas]');
    this.source = root.querySelector('[data-editor-source]');
    this.colorInput = root.querySelector('[data-editor-color]');
    this.sourceMode = false;

    this.bindToolbar();
  }

  bindToolbar() {
    this.root.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => {
        this.run(button.dataset.command);
      });
    });

    if (this.colorInput) {
      // Цвет применяем по отпускании кнопки мыши в палитре
      this.colorInput.addEventListener('change', () => {
        this.canvas.focus();
        document.execCommand('styleWithCSS', false, true);
        document.execCommand('foreColor', false, this.colorInput.value);
      });
    }
  }

  run(command) {
    if (command === 'source') {
      this.toggleSource();
      return;
    }

    this.canvas.focus();
    document.execCommand('styleWithCSS', false, true);

    switch (command) {
      case 'bold':
      case 'italic':
      case 'insertUnorderedList':
      case 'insertOrderedList':
      case 'removeFormat':
        document.execCommand(command, false, null);
        break;

      case 'createLink': {
        const selection = window.getSelection();
        const selected = selection ? selection.toString() : '';
        const url = window.prompt('Адрес ссылки', 'https://');
        if (!url) return;

        if (selected) {
          document.execCommand('createLink', false, url);
        } else {
          document.execCommand(
            'insertHTML',
            false,
            `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
          );
        }
        break;
      }

      case 'unlink':
        document.execCommand('unlink', false, null);
        break;

      default:
        break;
    }
  }

  toggleSource() {
    if (this.sourceMode) {
      this.canvas.innerHTML = this.source.value;
      this.source.hidden = true;
      this.canvas.hidden = false;
    } else {
      this.source.value = this.canvas.innerHTML;
      this.canvas.hidden = true;
      this.source.hidden = false;
    }
    this.sourceMode = !this.sourceMode;
    this.root
      .querySelector('[data-command="source"]')
      .classList.toggle('is-active', this.sourceMode);
  }

  setHtml(html) {
    if (this.sourceMode) this.toggleSource();
    this.canvas.innerHTML = html;
  }

  getHtml() {
    return this.sourceMode ? this.source.value : this.canvas.innerHTML;
  }

  getText() {
    const tmp = document.createElement('div');
    tmp.innerHTML = this.getHtml();
    return tmp.textContent || '';
  }
}

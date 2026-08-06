'use strict';

// ============================================================================
// Конфигурация по умолчанию
// ============================================================================

const KMS_ORIGIN = 'https://kms.headoffice.psbank.local';

// Страница, на которой проверяется авторизация (фаза 1).
const AUTH_PROBE_URL = `${KMS_ORIGIN}/content/space/2198/wiki/603498`;

const DEFAULT_CONFIG = {
  mainPageUrl: `${KMS_ORIGIN}/content/space/2198/wiki/774896`,
  packages: [
    {
      name: 'К-1 Системный клиентский',
      viewUrl: `${KMS_ORIGIN}/content/space/2198/wiki/772484`,
      editUrl: `${KMS_ORIGIN}/content/space/2198/wiki/772484?popup=article-editor&articleId=772484`,
      createChildUrl: `${KMS_ORIGIN}/content/space/2198/wiki/772499?chosenSpaceId=2198&popup=article-editor&articleId=new&article-type=ARTICLE&parentId=756914`,
    },
    {
      name: 'К-2 Базовый',
      viewUrl: `${KMS_ORIGIN}/content/space/2198/wiki/760944`,
      editUrl: `${KMS_ORIGIN}/content/space/2198/wiki/760944?popup=article-editor&articleId=760944`,
      createChildUrl: `${KMS_ORIGIN}/content/space/2198/wiki/772484?chosenSpaceId=2198&popup=article-editor&articleId=new&article-type=ARTICLE&parentId=746646`,
    },
    {
      name: 'К-3 Базовый-Плюс',
      viewUrl: `${KMS_ORIGIN}/content/space/2198/wiki/771929`,
      editUrl: `${KMS_ORIGIN}/content/space/2198/wiki/771929?popup=article-editor&articleId=771929`,
      createChildUrl: `${KMS_ORIGIN}/content/space/2198/wiki/760944?chosenSpaceId=2198&popup=article-editor&articleId=new&article-type=ARTICLE&parentId=756401`,
    },
    {
      name: 'К-4 Расширенный',
      viewUrl: `${KMS_ORIGIN}/content/space/2198/wiki/772112`,
      editUrl: `${KMS_ORIGIN}/content/space/2198/wiki/772112?popup=article-editor&articleId=772112`,
      createChildUrl: `${KMS_ORIGIN}/content/space/2198/wiki/771929?chosenSpaceId=2198&popup=article-editor&articleId=new&article-type=ARTICLE&parentId=756574`,
    },
    {
      name: 'К-5 Специальный',
      viewUrl: `${KMS_ORIGIN}/content/space/2198/wiki/772170`,
      editUrl: `${KMS_ORIGIN}/content/space/2198/wiki/772170?popup=article-editor&articleId=772170`,
      createChildUrl: `${KMS_ORIGIN}/content/space/2198/wiki/772112?chosenSpaceId=2198&popup=article-editor&articleId=new&article-type=ARTICLE&parentId=756630`,
    },
  ],
};

// ============================================================================
// Хранилище
// ============================================================================

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

async function loadConfig() {
  const stored = await chrome.storage.local.get('config');
  const config = stored.config;

  if (
    !config ||
    typeof config.mainPageUrl !== 'string' ||
    !Array.isArray(config.packages) ||
    config.packages.length === 0
  ) {
    return cloneDefaultConfig();
  }

  return {
    mainPageUrl: config.mainPageUrl,
    packages: config.packages.map((p) => ({
      name: String(p.name || ''),
      viewUrl: String(p.viewUrl || ''),
      editUrl: String(p.editUrl || ''),
      createChildUrl: String(p.createChildUrl || ''),
    })),
  };
}

async function saveConfig(config) {
  await chrome.storage.local.set({ config });
}

// ============================================================================
// Работа с адресами KMS
// ============================================================================

// Все идентификаторы вида /wiki/NNNN в строке URL
function wikiIdsIn(url) {
  return [...String(url).matchAll(/\/wiki\/(\d+)/g)].map((m) => m[1]);
}

function lastWikiId(url) {
  const ids = wikiIdsIn(url);
  return ids.length ? ids[ids.length - 1] : null;
}

function spaceIdIn(url) {
  const m = String(url).match(/\/content\/space\/(\d+)\//);
  return m ? m[1] : null;
}

// Адрес просмотра → адрес редактирования той же страницы.
// Головная страница задаётся в конфигурации только адресом просмотра,
// адрес редактирования строится по тому же правилу, что и у пакетов.
function toEditUrl(viewUrl) {
  const id = lastWikiId(viewUrl);
  if (!id) return null;
  const clean = String(viewUrl).split('?')[0];
  return `${clean}?popup=article-editor&articleId=${id}`;
}

// Строит «чистый» адрес просмотра страницы по адресу вкладки после публикации
function toViewUrl(url) {
  const space = spaceIdIn(url);
  const id = lastWikiId(url);
  if (!space || !id) return null;
  const origin = new URL(url).origin;
  return `${origin}/content/space/${space}/wiki/${id}`;
}

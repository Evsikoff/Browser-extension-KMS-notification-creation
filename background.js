// Интерфейс мастера живёт в отдельной вкладке: popup закрывался бы при каждом
// переключении на вкладки KMS, а мастер должен работать всю сессию.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('panel.html');
  const existing = await chrome.tabs.query({ url });

  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }

  await chrome.tabs.create({ url });
});

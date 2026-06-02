document.getElementById("open").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "openTab" });
  window.close();
});

chrome.runtime.sendMessage({ action: "status" }, (s) => {
  const dot = document.getElementById("dot");
  const msg = document.getElementById("msg");
  if (!s) {
    msg.textContent = "Reload the extension.";
    return;
  }
  if (s.hasSession) {
    dot.classList.add("ok");
    msg.textContent = "Ready — open the manager.";
  } else {
    msg.innerHTML = 'Log in to <a href="https://x.com" target="_blank">x.com</a> first.';
  }
});

(() => {
  "use strict";
  const localQA = navigator.webdriver === true &&
    ["localhost", "127.0.0.1"].includes(location.hostname) &&
    window.__NSG_QA_MODE__ === true;
  if (localQA || document.documentElement.classList.contains("nsg-shield-active")) return;
  const root = document.documentElement;
  const media = ".hero-sc-media,.ledger-thumb,.card-media,.dossier-stage-canvas,.dossier-thumb,.recent-item,#lightboxOverlay,.p-gallery-stage,.p-thumb-strip,.p-lb-stage,.hub-card-img-wrap,.ai-prop-card,.nsg-media-shield";
  root.classList.add("nsg-shield-active");

  for (const eventName of ["contextmenu", "dragstart"]) {
    document.addEventListener(eventName, event => {
      if (event.target instanceof Element && event.target.closest(media)) event.preventDefault();
    }, {capture: true});
  }

  document.addEventListener("keydown", event => {
    const key = String(event.key || "").toLowerCase();
    const tools = ["i", "j", "c"].includes(key);
    const windowsTools = event.ctrlKey && event.shiftKey && tools;
    const macTools = event.metaKey && event.altKey && (tools || key === "u");
    const sourceOrSave = (event.ctrlKey || event.metaKey) && !event.shiftKey && ["u", "s"].includes(key);
    if (key === "f12" || event.keyCode === 123 || windowsTools || macTools || sourceOrSave) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, {capture: true});

  // A docked side pane sometimes shrinks the CSS viewport without resizing the window.
  // Compare relative changes from this window's own baseline. This is a visual hint only.
  if (!matchMedia("(pointer: fine)").matches) return;
  const view = () => ({
    w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight, dpr: devicePixelRatio,
    scale: window.visualViewport?.scale ?? 1,
  });
  let baseline = view();
  let pending;
  function checkViewport() {
    const now = view();
    if (now.ow !== baseline.ow || now.oh !== baseline.oh ||
        now.dpr !== baseline.dpr || now.scale !== baseline.scale) {
      baseline = now;
      root.classList.remove("nsg-detail-dimmed");
      return;
    }
    const dx = (baseline.w - now.w) / Math.max(1, baseline.w);
    const dy = (baseline.h - now.h) / Math.max(1, baseline.h);
    const pane = (dx > 0.12 && Math.abs(dy) < 0.03) ||
      (dy > 0.17 && Math.abs(dx) < 0.03);
    root.classList.toggle("nsg-detail-dimmed", pane);
  }
  window.addEventListener("resize", () => {
    clearTimeout(pending);
    pending = setTimeout(checkViewport, 250);
  }, {passive: true});
})();

(() => {
  "use strict";
  const localQA = navigator.webdriver === true &&
    ["localhost", "127.0.0.1"].includes(location.hostname) &&
    window.__NSG_QA_MODE__ === true;
  if (localQA || document.documentElement.classList.contains("nsg-shield-active")) return;
  const root = document.documentElement;
  const media = ".hero-sc-media,.ledger-thumb,.card-media,.dossier-stage-canvas,.dossier-thumb,.recent-item,#lightboxOverlay,.p-gallery-stage,.p-thumb-strip,.p-lb-stage,.hub-card-img-wrap,.p-rel-img,.gallery-item,.ai-prop-card,.nsg-media-shield,.nsg-img-shield-wrap,.nsg-stage-fit,.nsg-lb-fit,.p-stage-fit,.p-lb-fit,.nsg-touch-shield";
  const DIRECT_SHIELD_PARENTS = new Set([
    "media-frame-inner", "ledger-thumb", "dossier-thumb", "card-media", "hero-sc-media",
    "dossier-stage-canvas", "nsg-stage-fit", "nsg-lb-fit", "p-stage-fit", "p-lb-fit",
    "p-gallery-stage", "p-lb-stage", "p-thumb-btn", "hub-card-img-wrap", "p-rel-img",
    "gallery-item", "nsg-media-shield", "nsg-img-shield-wrap"
  ]);
  const OUTER_BACKDROP_FRAMES = [".card-media", ".hero-sc-media", ".dossier-stage-canvas", ".p-gallery-stage"];
  root.classList.add("nsg-shield-active");

  for (const eventName of ["contextmenu", "dragstart", "selectstart"]) {
    document.addEventListener(eventName, event => {
      if (event.target instanceof Element && event.target.closest(media)) {
        event.preventDefault();
      }
    }, { capture: true });
  }

  function hasDirectShield(el) {
    for (let i = 0; i < el.children.length; i++) {
      if (el.children[i].classList && el.children[i].classList.contains("nsg-touch-shield")) return true;
    }
    return false;
  }

  function ensureDirectShield(parent, zIndexVal) {
    if (!(parent instanceof Element) || hasDirectShield(parent)) return;
    const cs = getComputedStyle(parent);
    if (cs.position === "static") parent.style.position = "relative";
    const shield = document.createElement("span");
    shield.className = "nsg-touch-shield";
    shield.setAttribute("aria-hidden", "true");
    if (zIndexVal) shield.style.zIndex = String(zIndexVal);
    parent.appendChild(shield);
  }

  function wrapMultiColumnImage(img) {
    const parent = img.parentElement;
    if (!(parent instanceof Element) || parent.classList.contains("nsg-img-shield-wrap")) return;
    const wrap = document.createElement("span");
    wrap.className = "nsg-img-shield-wrap";
    parent.insertBefore(wrap, img);
    wrap.appendChild(img);
    ensureDirectShield(wrap, 2);
  }

  function mountTouchShields(scope) {
    const rootNode = scope instanceof Element || scope instanceof Document ? scope : document;
    rootNode.querySelectorAll(OUTER_BACKDROP_FRAMES.join(",")).forEach(frame => {
      ensureDirectShield(frame, 1);
    });
    const imgs = rootNode.querySelectorAll("img");
    imgs.forEach(img => {
      if (img.classList.contains("p-stage-blur")) return;
      const container = img.closest(media);
      if (!container) return;
      img.setAttribute("draggable", "false");
      const parent = img.parentElement;
      if (!(parent instanceof Element)) return;
      const isDirectFrame = Array.from(parent.classList).some(cls => DIRECT_SHIELD_PARENTS.has(cls));
      if (isDirectFrame) {
        ensureDirectShield(parent, 2);
      } else if (parent.classList.contains("recent-item") || parent.classList.contains("ai-prop-card") || parent.id === "lightboxOverlay") {
        wrapMultiColumnImage(img);
      } else {
        ensureDirectShield(parent, 2);
      }
    });
  }

  let mountRaf = 0;
  function scheduleMount() {
    if (mountRaf) return;
    mountRaf = requestAnimationFrame(() => {
      mountRaf = 0;
      mountTouchShields(document);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountTouchShields(document), { once: true });
  } else {
    mountTouchShields(document);
  }

  if (typeof MutationObserver !== "undefined") {
    const startObserver = () => {
      const target = document.body || document.documentElement;
      if (!target) return;
      const obs = new MutationObserver(scheduleMount);
      obs.observe(target, { childList: true, subtree: true });
    };
    if (document.body) startObserver();
    else document.addEventListener("DOMContentLoaded", startObserver, { once: true });
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
  }, { capture: true });

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
  }, { passive: true });
})();

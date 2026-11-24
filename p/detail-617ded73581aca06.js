window.nsgDetail_617ded73581aca06 = function(PID, listingId) {
(function() {
  var SVG_MOON = "<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.85\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\"/></svg>";
  var SVG_SUN = "<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.85\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2\"/><path d=\"M12 20v2\"/><path d=\"m4.93 4.93 1.41 1.41\"/><path d=\"m17.66 17.66 1.41 1.41\"/><path d=\"M2 12h2\"/><path d=\"M20 12h2\"/><path d=\"m6.34 17.66-1.41 1.41\"/><path d=\"m19.07 4.93-1.41 1.41\"/></svg>";
  var SVG_HEART_EMPTY = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z\"/></svg>";
  var SVG_HEART_FILLED = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z\"/></svg>";
  if (typeof window.toggleStaticTheme !== "function") {
    window.toggleStaticTheme = function() {
      var isDark = document.documentElement.classList.toggle("dark");
      var mode = isDark ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", mode);
      var cm = document.querySelector('meta[name="color-scheme"]');
      if (cm) cm.content = mode;
      try { localStorage.setItem("nhatosg_theme_mode", mode); } catch (e) {}
      var tb = document.getElementById("pThemeBtn");
      if (tb) tb.innerHTML = isDark ? SVG_SUN : SVG_MOON;
    };
    var initTb = document.getElementById("pThemeBtn");
    if (initTb) initTb.innerHTML = document.documentElement.classList.contains("dark") ? SVG_SUN : SVG_MOON;
  }
  function readArr(key) {
    try {
      var a = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  function writeArr(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {}
  }
  // Record into Recently Viewed (max 8, MRU first)
  var recents = readArr("nhatosg_recent_ids").filter(function(x) { return x && x !== PID; });
  recents.unshift(PID);
  writeArr("nhatosg_recent_ids", recents.slice(0, 8));

  function syncSavedState() {
    var saved = readArr("nhatosg_saved_ids");
    var isSaved = saved.indexOf(PID) !== -1;
    var btn = document.getElementById("pSaveFavBtn");
    if (btn) {
      btn.classList.toggle("saved", isSaved);
      btn.innerHTML = (isSaved ? SVG_HEART_FILLED : SVG_HEART_EMPTY) + "<span>" + (isSaved ? "Đã lưu" : "Lưu") + "</span>";
    }
  }
  window.toggleStaticSaved = function() {
    var saved = readArr("nhatosg_saved_ids");
    var idx = saved.indexOf(PID);
    var nowSaved = false;
    if (idx === -1) { saved.unshift(PID); nowSaved = true; }
    else { saved.splice(idx, 1); }
    writeArr("nhatosg_saved_ids", saved.slice(0, 60));
    syncSavedState();
    var toast = document.getElementById("pZaloToast");
    if (toast) {
      toast.textContent = nowSaved ? ("✓ Đã lưu [" + PID + "] vào Tài sản Quan Tâm") : ("Đã bỏ lưu [" + PID + "]");
      toast.style.display = "block";
      setTimeout(function() { toast.style.display = "none"; }, 2200);
    }
  };
  function upgradeRelatedWebp() {
    if (!window.__OPTIMIZED_IMAGE_MAP__) return;
    var imgs = document.querySelectorAll(".p-related-sec img[data-raw]");
    for (var i = 0; i < imgs.length; i++) {
      var clean = String(imgs[i].getAttribute("data-raw") || "").replace(/^https?:\/\/[^/]+\//i, "").replace(/^\.?\//, "").toLowerCase();
      var kBack = clean.replace(/\//g, "\\");
      var kFwd = clean.replace(/\\/g, "/");
      var entry = window.__OPTIMIZED_IMAGE_MAP__[kBack] || window.__OPTIMIZED_IMAGE_MAP__[kFwd];
      if (entry && entry.card) {
        imgs[i].src = String(entry.card).startsWith("https://") ? entry.card : "/" + String(entry.card).replace(/^\.?\//, "").replace(/\\/g, "/");
      }
    }
  }
  syncSavedState();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", upgradeRelatedWebp);
  } else {
    upgradeRelatedWebp();
  }
  window.addEventListener("load", upgradeRelatedWebp);
})();

};

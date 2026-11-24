window.nsgDetail_85af7cf326de80a9 = function(GALLERY, ZALO_TEXT, listingId) {
(function() {
  var curIdx = 0;
  var lastSwipeTs = 0;
  var lastTouchOpenTs = 0;
  var suppressPop = false;

  var SVG_MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
  var SVG_SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
  function syncThemeIcon() {
    var btn = document.getElementById("pThemeBtn");
    var isDark = document.documentElement.classList.contains("dark");
    if (btn) btn.innerHTML = isDark ? SVG_SUN : SVG_MOON;
  }

  window.toggleStaticTheme = function() {
    var isDark = document.documentElement.classList.toggle("dark");
    var mode = isDark ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", mode);
    var cm = document.querySelector('meta[name="color-scheme"]');
    if (cm) cm.content = mode;
    try { localStorage.setItem("nhatosg_theme_mode", mode); } catch (e) {}
    syncThemeIcon();
  };

  function resolveRootWebp(rawPath, variant, fallbackAbs) {
    if (!rawPath || !window.__OPTIMIZED_IMAGE_MAP__) return fallbackAbs;
    var clean = String(rawPath).replace(/^https?:\/\/[^/]+\//i, "").replace(/^\.?\//, "").toLowerCase();
    var kBack = clean.replace(/\//g, "\\");
    var kFwd = clean.replace(/\\/g, "/");
    var entry = window.__OPTIMIZED_IMAGE_MAP__[kBack] || window.__OPTIMIZED_IMAGE_MAP__[kFwd];
    if (entry && entry[variant]) {
      return String(entry[variant]).startsWith("https://") ? entry[variant] : "/" + String(entry[variant]).replace(/^\.?\//, "").replace(/\\/g, "/");
    }
    return fallbackAbs;
  }

  function renderSlide() {
    if (!GALLERY.length) return;
    curIdx = ((curIdx % GALLERY.length) + GALLERY.length) % GALLERY.length;
    var item = GALLERY[curIdx];
    var mainEl = document.getElementById("pMainImg");
    var blurEl = document.getElementById("pBlurImg");
    var idxEl = document.getElementById("pGalIdx");
    var lbIdxEl = document.getElementById("pLbIdx");
    var lbImg = document.getElementById("pLbImg");

    var detailSrc = resolveRootWebp(item.raw, "detail", item.abs);
    if (mainEl) {
      mainEl.dataset.fallback = item.abs;
      mainEl.alt = item.cap;
      mainEl.src = detailSrc;
    }
    if (blurEl) blurEl.src = detailSrc;
    if (idxEl) idxEl.textContent = String(curIdx + 1);
    if (lbIdxEl) lbIdxEl.textContent = String(curIdx + 1);
    if (lbImg) {
      lbImg.dataset.fallback = item.abs;
      lbImg.alt = item.cap;
      lbImg.src = resolveRootWebp(item.raw, "lightbox", item.abs);
    }
    var isWmV2 = /(?:^|[\/_-])wmv2(?:[._-]|$)/i.test(String(item.raw || item.abs || ""));
    var wmStage = document.getElementById("pWatermark");
    var wmLb = document.getElementById("pLbWatermark");
    if (wmStage) wmStage.classList.toggle("wm-hidden", isWmV2);
    if (wmLb) wmLb.classList.toggle("wm-hidden", isWmV2);

    var strip = document.getElementById("pThumbStrip");
    if (strip) {
      var btns = strip.querySelectorAll(".p-thumb-btn");
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle("active", i === curIdx);
      }
      var activeBtn = btns[curIdx];
      if (activeBtn) {
        var targetLeft = activeBtn.offsetLeft - (strip.clientWidth / 2) + (activeBtn.clientWidth / 2);
        try { strip.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" }); } catch (e) { strip.scrollLeft = Math.max(0, targetLeft); }
      }
    }
  }

  window.selectStaticSlide = function(idx) {
    curIdx = idx;
    renderSlide();
  };

  window.stepStaticSlide = function(delta) {
    if (window.event) window.event.stopPropagation();
    curIdx += delta;
    renderSlide();
  };

  window.handleStageTap = function() {
    if (Date.now() - lastSwipeTs < 220) return;
    if (Date.now() - lastTouchOpenTs < 450) return;
    window.openStaticLightbox();
  };

  window.openStaticLightbox = function() {
    var lb = document.getElementById("pLightbox");
    if (!lb || lb.classList.contains("open")) return;
    lb.classList.add("open");
    document.body.style.overflow = "hidden";
    renderSlide();
    try { history.pushState({ nsgStaticLb: true }, "", window.location.href); } catch (e) {}
  };

  window.closeStaticLightbox = function(fromPop) {
    var lb = document.getElementById("pLightbox");
    if (!lb || !lb.classList.contains("open")) return;
    lb.classList.remove("open");
    document.body.style.overflow = "";
    if (!fromPop && history.state && history.state.nsgStaticLb) {
      suppressPop = true;
      try { history.back(); } catch (e) { suppressPop = false; }
    }
  };

  window.addEventListener("popstate", function() {
    if (suppressPop) { suppressPop = false; return; }
    var lb = document.getElementById("pLightbox");
    if (lb && lb.classList.contains("open")) {
      window.closeStaticLightbox(true);
    }
  });

  window.quickStaticZaloRequest = function() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ZALO_TEXT).catch(function() {});
    }
    var toast = document.getElementById("pZaloToast");
    if (toast) {
      toast.textContent = "✓ Đã sao chép mã [" + listingId + "] — Đang mở Zalo 0916.23.9898 (Vũ)";
      toast.style.display = "block";
      setTimeout(function() { toast.style.display = "none"; }, 3200);
    }
    window.open("https://zalo.me/0916239898", "_blank", "noopener");
  };

  function attachSwipe(elId, allowTapOpen) {
    var el = document.getElementById(elId);
    if (!el) return;
    var tracking = false, moved = false, multiTouch = false;
    var sx = 0, sy = 0, t0 = 0, startScrollY = 0;
    function resetTouch() {
      tracking = false;
      moved = false;
      multiTouch = false;
    }
    el.addEventListener("touchstart", function(e) {
      if (e.touches && e.touches.length > 1) {
        multiTouch = true;
        return;
      }
      if (!e.changedTouches || !e.changedTouches.length) return;
      tracking = true;
      moved = false;
      multiTouch = false;
      sx = e.changedTouches[0].clientX;
      sy = e.changedTouches[0].clientY;
      t0 = Date.now();
      startScrollY = window.scrollY || window.pageYOffset || 0;
    }, { passive: true });
    el.addEventListener("touchmove", function(e) {
      if (!tracking || !e.touches || !e.touches.length) return;
      if (e.touches.length > 1) {
        multiTouch = true;
        return;
      }
      var dx = e.touches[0].clientX - sx;
      var dy = e.touches[0].clientY - sy;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true;
    }, { passive: true });
    el.addEventListener("touchcancel", resetTouch, { passive: true });
    el.addEventListener("touchend", function(e) {
      if (!tracking || !e.changedTouches || !e.changedTouches.length) {
        resetTouch();
        return;
      }
      var t = e.changedTouches[0];
      var dx = t.clientX - sx;
      var dy = t.clientY - sy;
      var dt = Date.now() - t0;
      var dScroll = Math.abs((window.scrollY || window.pageYOffset || 0) - startScrollY);
      var wasMoved = moved;
      var wasMulti = multiTouch;
      resetTouch();
      if (wasMulti) return;
      if (GALLERY.length >= 2 && Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.15 && dScroll < 24) {
        lastSwipeTs = Date.now();
        curIdx += (dx < 0 ? 1 : -1);
        renderSlide();
        return;
      }
      if (allowTapOpen && !wasMoved && Math.abs(dx) <= 10 && Math.abs(dy) <= 10 && dScroll <= 6 && dt < 450) {
        if (Date.now() - lastSwipeTs < 180) return;
        if (e.target && e.target.closest && e.target.closest("button,a")) return;
        lastTouchOpenTs = Date.now();
        window.openStaticLightbox();
      }
    }, { passive: true });
  }

  function upgradeThumbsAndMain() {
    var strip = document.getElementById("pThumbStrip");
    if (strip && window.__OPTIMIZED_IMAGE_MAP__) {
      var imgs = strip.querySelectorAll("img[data-raw]");
      for (var i = 0; i < imgs.length; i++) {
        var raw = imgs[i].getAttribute("data-raw");
        var fb = imgs[i].getAttribute("data-fallback") || imgs[i].src;
        var opt = resolveRootWebp(raw, "gallery", fb);
        if (opt && opt !== imgs[i].src) imgs[i].src = opt;
      }
    }
    renderSlide();
  }

  syncThemeIcon();
  attachSwipe("pGalleryStage", true);
  attachSwipe("pLbStage", false);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", upgradeThumbsAndMain);
  } else {
    upgradeThumbsAndMain();
  }
})();

};

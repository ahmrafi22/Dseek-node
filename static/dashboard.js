/* Dashboard number-format toggle: one button cycling 1,000 -> M.
   M mode auto-upgrades to B past a billion. Rewrites rendered stat values,
   table numbers, hero total and chart labels in place (each parsed once,
   stashed in data-raw). Choice persists in localStorage. No dependencies. */
(function () {
  var KEY = "ds-numfmt";
  var MODES = ["comma", "M"];
  var LABELS = { comma: "1,000", M: "M" };
  var mode = "comma";
  try {
    mode = localStorage.getItem(KEY) || "comma";
  } catch (e) { /* storage unavailable: stay on comma */ }
  if (MODES.indexOf(mode) < 0) mode = "comma";

  function fmtInt(n, dec) {
    if (dec > 0) {
      return n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    }
    return Math.round(n).toLocaleString("en-US");
  }

  function fmt(n, prefix, suffix, dec) {
    suffix = suffix || "";
    if (mode === "comma") return prefix + fmtInt(n, dec) + suffix;
    var a = Math.abs(n), u;
    u = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : null;
    if (!u) return prefix + fmtInt(n, dec) + suffix;
    return prefix + (n / u[0]).toFixed(2) + u[1] + suffix;
  }

  function parse(el) {
    var t = (el.textContent || "").trim();
    var m = t.match(/^([^0-9\-]*)([\d,]+(?:\.\d+)?)(.*)$/);
    if (!m) return null;
    var n = parseFloat(m[2].replace(/,/g, ""));
    if (isNaN(n)) return null;
    var dec = m[2].indexOf(".") >= 0 ? m[2].split(".")[1].length : 0;
    return { prefix: m[1], n: n, suffix: m[3], dec: dec };
  }

  function paint(btn) {
    if (btn) btn.textContent = LABELS[mode];
  }

  function apply(btn) {
    var els = document.querySelectorAll(".card .v, td.num, .hero-total, .dv");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.dataset.raw) {
        var p = parse(el);
        if (!p) continue;
        try {
          el.dataset.raw = JSON.stringify(p);
        } catch (e) {
          continue;
        }
      }
      var s;
      try {
        s = JSON.parse(el.dataset.raw);
      } catch (e) {
        continue;
      }
      el.textContent = fmt(s.n, s.prefix, s.suffix, s.dec);
    }
    paint(btn);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("numfmt");
    if (!btn) return;
    btn.addEventListener("click", function () {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      try {
        localStorage.setItem(KEY, mode);
      } catch (e) { /* ignore */ }
      apply(btn);
    });
    apply(btn);
  });
})();

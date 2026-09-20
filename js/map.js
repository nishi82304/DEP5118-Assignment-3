// Teck Ghee Noise Map: reads the Google Sheet (or sample data), places each
// postal code with OneMap, and draws the readings on a Mapbox map with the
// AR5952J site boundary.
(function () {
  var C = window.NOISE_CONFIG || {};

  // These must match the choices in the Google Form (setup/create-form.gs)
  var SOURCES = ["Construction", "Road traffic", "Home renovation", "Neighbours", "People using the space",
    "Hawker centre / F&B", "Void deck or CC event", "School", "Other"];
  var SPACES = ["Void deck", "Playground", "Fitness corner", "Hawker centre or coffee shop", "CC or RC space",
    "Park or garden", "Sports court", "Covered walkway", "Other"];
  var AGES = ["Children (under 12)", "Teenagers (13 to 19)", "Young adults (20 to 39)", "Adults (40 to 64)", "Seniors (65 and above)"];
  var AGE_SHORT = { "Children (under 12)": "Children", "Teenagers (13 to 19)": "Teenagers", "Young adults (20 to 39)": "Young adults",
    "Adults (40 to 64)": "Adults 40 to 64", "Seniors (65 and above)": "Seniors" };
  var TIMES = ["Early morning (6am to 9am)", "Daytime (9am to 6pm)", "Evening (6pm to 10pm)", "Night (10pm to 6am)"];
  var BANDS = [
    { max: 55, color: "#f7b36b", label: "Under 55 dB", name: "Quiet", text: "#34403a" },
    { max: 65, color: "#f3843f", label: "55 to 65 dB", name: "Noticeable", text: "#34403a" },
    { max: 75, color: "#e8412c", label: "65 to 75 dB", name: "Loud", text: "#fff" },
    { max: 85, color: "#c1121f", label: "75 to 85 dB", name: "Very loud", text: "#fff" },
    { max: 999, color: "#780000", label: "85 dB and above", name: "Harmful over time", text: "#fff" }
  ];
  function band(db) { for (var i = 0; i < BANDS.length; i++) if (db < BANDS[i].max) return BANDS[i]; return BANDS[4]; }

  var state = { all: [], sources: new Set(SOURCES), time: "", age: "", space: "", view: "points" };
  var map = null, mapReady = false, siteArea = null;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- Panel controls ----------
  SOURCES.forEach(function (s) {
    var b = document.createElement("button");
    b.className = "chip"; b.textContent = s; b.setAttribute("aria-pressed", "true");
    b.onclick = function () {
      if (state.sources.has(s)) state.sources.delete(s); else state.sources.add(s);
      b.setAttribute("aria-pressed", state.sources.has(s)); refresh();
    };
    $("chips").appendChild(b);
  });
  function fill(sel, list, label) { list.forEach(function (v) { var o = document.createElement("option"); o.value = v; o.textContent = label ? label(v) : v; $(sel).appendChild(o); }); }
  fill("time", TIMES); fill("space", SPACES); fill("age", AGES, function (a) { return a + " present"; });
  $("time").onchange = function () { state.time = this.value; refresh(); };
  $("space").onchange = function () { state.space = this.value; refresh(); };
  $("age").onchange = function () { state.age = this.value; refresh(); };
  $("legend").innerHTML = BANDS.map(function (b) {
    return '<div class="legend-row"><i style="background:' + b.color + ';box-shadow:0 0 6px 2px ' + b.color + '"></i>' + b.label + ' <span class="muted">· ' + b.name + '</span></div>';
  }).join("") +
    '<div class="legend-row small muted" style="margin-top:8px">Bigger glow = louder reading</div>' +
    '<div class="legend-row"><i style="background:transparent;border:2px dashed #4c6b53;border-radius:3px;box-shadow:none"></i>Site area (updated 20 Aug 2026)</div>';
  ["points", "heat"].forEach(function (v) {
    $("v-" + v).onclick = function () {
      state.view = v;
      $("v-points").setAttribute("aria-pressed", v === "points");
      $("v-heat").setAttribute("aria-pressed", v === "heat");
      applyView();
    };
  });

  // ---------- Map ----------
  if (!C.mapboxToken) {
    $("map").innerHTML = '<div class="map-message"><div><h3>Map token missing</h3><p>Add your Mapbox public token (starts with <b>pk.</b>) to <code>mapboxToken</code> in <code>js/config.js</code>. The summary on the left still works.</p></div></div>';
  } else {
    mapboxgl.accessToken = C.mapboxToken;
    map = new mapboxgl.Map({
      container: "map", style: C.mapStyle || "mapbox://styles/mapbox/light-v11",
      center: C.center || [103.8555, 1.3650], zoom: C.zoom || 15.6
    });
    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.on("load", function () {
      map.addSource("site", { type: "geojson", data: "data/site-area.geojson" });
      map.addLayer({ id: "site-fill", type: "fill", source: "site", paint: { "fill-color": "#b5c9b6", "fill-opacity": 0.12 } });
      map.addLayer({ id: "site-line", type: "line", source: "site",
        paint: { "line-color": "#4c6b53", "line-width": 2.5, "line-dasharray": [1.2, 1.2] } });

      map.addSource("reports", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "reports-heat", type: "heatmap", source: "reports", layout: { visibility: "none" },
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "db"], 45, 0.05, 90, 1],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 13, 28, 17, 90],
          "heatmap-intensity": 2, "heatmap-opacity": 0.85,
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(247,179,107,0)", 0.2, "#f7b36b", 0.45, "#f3843f", 0.65, "#e8412c", 0.85, "#c1121f", 1, "#780000"]
        }
      });
      map.addLayer({
        id: "reports", type: "circle", source: "reports",
        paint: {
          "circle-color": ["step", ["get", "db"], BANDS[0].color, 55, BANDS[1].color, 65, BANDS[2].color, 75, BANDS[3].color, 85, BANDS[4].color],
          // louder readings are bigger; everything grows as you zoom in
          "circle-radius": ["interpolate", ["linear"], ["zoom"],
            13, ["interpolate", ["linear"], ["get", "db"], 40, 3, 80, 7, 110, 12],
            15, ["interpolate", ["linear"], ["get", "db"], 40, 6, 80, 14, 110, 24],
            17, ["interpolate", ["linear"], ["get", "db"], 40, 14, 80, 32, 110, 54]],
          "circle-blur": 0.65,
          "circle-opacity": 0.9
        }
      });
      map.on("click", "reports", function (e) {
        var p = e.features[0].properties;
        new mapboxgl.Popup({ offset: 8 }).setLngLat(e.features[0].geometry.coordinates).setHTML(popupHTML(p)).addTo(map);
      });
      map.on("mouseenter", "reports", function () { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "reports", function () { map.getCanvas().style.cursor = ""; });

      fetch("data/site-area.geojson").then(function (r) { return r.json(); }).then(function (g) {
        var b = new mapboxgl.LngLatBounds();
        g.features[0].geometry.coordinates[0].forEach(function (c) { b.extend(c); });
        map.fitBounds(b, { padding: 30, duration: 0 });
      }).catch(function () {});

      mapReady = true; refresh(); applyView();
    });
  }

  function applyView() {
    if (!mapReady) return;
    map.setLayoutProperty("reports", "visibility", state.view === "points" ? "visible" : "none");
    map.setLayoutProperty("reports-heat", "visibility", state.view === "heat" ? "visible" : "none");
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function popupHTML(p) {
    var b = band(p.db);
    var ages = (p.ages || "").split("|").filter(Boolean).map(function (a) { return AGE_SHORT[a] || a; }).join(", ");
    var row = function (k, v) { return v ? '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>' : ''; };
    return '<div class="pop">' +
      '<div class="addr">' + esc(p.space) + ' · ' + esc(p.address || ("near " + p.postal)) + '</div>' +
      '<div class="pop-db"><b>' + p.db + '</b> dB <span style="background:' + b.color + ';color:' + b.text + '">' + b.name + '</span></div>' +
      '<dl>' + row("Source", p.source) + row("Who was there", ages) + row("Doing", p.activities) +
      row("When", p.time) + row("Lasted", p.duration) + row("Effect", p.effect) + row("Reported by", p.ownAge ? "Age " + p.ownAge : "") +
      row("Date", p.date) + '</dl>' +
      (p.notes ? '<div class="note">"' + esc(p.notes) + '"</div>' : '') + '</div>';
  }

  // ---------- Filtering, stats, map update ----------
  function visible() {
    return state.all.filter(function (r) {
      if (!state.sources.has(r.source)) return false;
      if (state.time && r.time !== state.time) return false;
      if (state.space && r.space !== state.space) return false;
      if (state.age === "__mixed" && r.ages.length < 2) return false;
      if (state.age && state.age !== "__mixed" && r.ages.indexOf(state.age) === -1) return false;
      return true;
    });
  }

  function avgBy(rows, keysOf, order, label) {
    var g = {};
    rows.forEach(function (r) { keysOf(r).forEach(function (k) { (g[k] = g[k] || []).push(r.db); }); });
    var out = Object.keys(g).map(function (k) {
      var a = g[k]; return { k: k, avg: a.reduce(function (x, y) { return x + y; }, 0) / a.length, n: a.length };
    });
    if (order) out.sort(function (a, b) { return order.indexOf(a.k) - order.indexOf(b.k); });
    else out.sort(function (a, b) { return b.avg - a.avg; });
    if (!out.length) return '<p class="small muted">No reports match these filters.</p>';
    return out.map(function (a) {
      var w = Math.max(4, Math.min(100, (a.avg - 40) / 50 * 100));
      return '<div class="bar"><span title="' + a.n + ' reports">' + esc(label ? label(a.k) : a.k) + ' <span class="muted">(' + a.n + ')</span></span>' +
        '<div class="track"><div class="fill" style="width:' + w + '%;background:' + band(a.avg).color + '"></div></div><span class="val">' + Math.round(a.avg) + '</span></div>';
    }).join("");
  }

  function refresh() {
    var rows = visible();
    var dbs = rows.map(function (r) { return r.db; }).sort(function (a, b) { return a - b; });
    var median = dbs.length ? (dbs.length % 2 ? dbs[(dbs.length - 1) / 2] : (dbs[dbs.length / 2 - 1] + dbs[dbs.length / 2]) / 2) : null;
    var pct = function (n) { return rows.length ? Math.round(100 * n / rows.length) + "%" : "–"; };
    $("s-count").textContent = rows.length;
    $("s-median").textContent = median == null ? "–" : Math.round(median);
    $("s-loud").textContent = pct(dbs.filter(function (d) { return d >= 65; }).length);
    $("s-mixed").textContent = pct(rows.filter(function (r) { return r.ages.length >= 2; }).length);

    $("bars-age").innerHTML = avgBy(rows, function (r) { return r.ages; }, AGES, function (k) { return AGE_SHORT[k]; });
    $("bars-space").innerHTML = avgBy(rows, function (r) { return [r.space]; });
    $("bars").innerHTML = avgBy(rows, function (r) { return [r.source]; });

    if (mapReady) {
      map.getSource("reports").setData({
        type: "FeatureCollection",
        features: rows.map(function (r) {
          return { type: "Feature", geometry: { type: "Point", coordinates: [r.lng, r.lat] },
            properties: { db: r.db, postal: r.postal, address: r.address, space: r.space, source: r.source,
              ages: r.ages.join("|"), ageCount: r.ages.length, activities: r.activities, ownAge: r.ownAge,
              time: r.time, duration: r.duration, effect: r.effect, notes: r.notes, date: r.date } };
        })
      });
    }
  }

  // ---------- Reading the data ----------
  function findField(fields, tests) {
    for (var j = 0; j < tests.length; j++)
      for (var i = 0; i < fields.length; i++) if (tests[j](fields[i].toLowerCase().trim())) return fields[i];
    return null;
  }
  var has = function (s) { return function (f) { return f.indexOf(s) !== -1; }; };
  var is = function (s) { return function (f) { return f === s; }; };

  function loadCSV(url) {
    return new Promise(function (resolve, reject) {
      Papa.parse(url, { download: true, header: true, skipEmptyLines: true, complete: resolve, error: reject });
    });
  }

  var cache = {};
  try { cache = JSON.parse(localStorage.getItem("onemap-cache") || "{}"); } catch (e) { cache = {}; }
  function saveCache() { try { localStorage.setItem("onemap-cache", JSON.stringify(cache)); } catch (e) {} }

  function geocode(postal) {
    if (cache[postal]) return Promise.resolve(cache[postal]);
    var url = "https://www.onemap.gov.sg/api/common/elastic/search?searchVal=" + postal + "&returnGeom=Y&getAddrDetails=Y&pageNum=1";
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var hit = (j.results || []).find(function (x) { return x.POSTAL === postal; }) || (j.results || [])[0];
      if (!hit) return null;
      cache[postal] = { lat: +hit.LATITUDE, lng: +hit.LONGITUDE, address: hit.ADDRESS };
      saveCache(); return cache[postal];
    }).catch(function () { return null; });
  }

  // Spread reports that share a block into a small ring so they don't stack
  function spread(rows) {
    var groups = {};
    rows.forEach(function (r) { var k = r.lat.toFixed(5) + "," + r.lng.toFixed(5); (groups[k] = groups[k] || []).push(r); });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k]; if (g.length < 2) return;
      g.forEach(function (r, i) {
        var ring = 1 + Math.floor(i / 8), a = (i % 8) / Math.min(g.length, 8) * 2 * Math.PI;
        r.lat += Math.sin(a) * 0.00016 * ring; r.lng += Math.cos(a) * 0.00016 * ring;
      });
    });
  }

  // The postal column may hold just "560470" or a full address ending in the postal code
  function postalOf(v) { var m = String(v).match(/\d{6}/g); return m ? m[m.length - 1] : ""; }
  function addressOf(v) { v = String(v).trim(); return /[a-z]/i.test(v) ? v : ""; }

  function status(msg) { $("status").innerHTML = msg; }

  var usingSample = !C.sheetCsvUrl;
  var src = usingSample ? "data/sample.csv" : C.sheetCsvUrl + (C.sheetCsvUrl.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
  if (!usingSample) $("csv-link").href = C.sheetCsvUrl;

  loadCSV(src).then(function (res) {
    var F = res.meta.fields || [];
    var col = {
      postal: findField(F, [has("postal")]),
      space: findField(F, [has("type of public space"), has("public space"), has("type of space")]),
      db: findField(F, [has("(db)"), has("decibel"), has("noise level")]),
      source: findField(F, [has("source")]),
      ages: findField(F, [has("who is using"), has("who was")]),
      activities: findField(F, [has("doing")]),
      time: findField(F, [has("when did"), has("time of day")]),
      duration: findField(F, [has("how long"), has("duration")]),
      effect: findField(F, [has("affect")]),
      ownAge: findField(F, [has("your age")]),
      notes: findField(F, [has("anything else"), has("note"), has("comment")]),
      stamp: findField(F, [is("timestamp")]),
      lat: findField(F, [is("lat"), is("latitude")]),
      lng: findField(F, [is("lng"), is("lon"), is("longitude")])
    };
    var get = function (d, k) { return col[k] ? String(d[col[k]] || "").trim() : ""; };
    var rows = res.data.map(function (d) {
      var db = parseFloat(get(d, "db").replace(/[^\d.]/g, ""));
      var source = get(d, "source"), space = get(d, "space");
      var ages = AGES.filter(function (a) { return get(d, "ages").indexOf(a) !== -1; });
      return {
        db: Math.round(db), postal: postalOf(get(d, "postal")), address: addressOf(get(d, "postal")),
        source: SOURCES.indexOf(source) !== -1 ? source : "Other",
        space: SPACES.indexOf(space) !== -1 ? space : "Other",
        ages: ages, activities: get(d, "activities"), ownAge: get(d, "ownAge") === "Prefer not to say" ? "" : get(d, "ownAge"),
        time: get(d, "time"), duration: get(d, "duration"), effect: get(d, "effect"),
        notes: get(d, "notes"), date: get(d, "stamp").split(" ")[0],
        lat: col.lat ? parseFloat(d[col.lat]) : NaN, lng: col.lng ? parseFloat(d[col.lng]) : NaN
      };
    }).filter(function (r) { return r.db >= 30 && r.db <= 130 && (r.postal.length === 6 || !isNaN(r.lat)); });

    var need = rows.filter(function (r) { return isNaN(r.lat) || isNaN(r.lng); });
    status("Placing " + need.length + " reports on the map…");
    var queue = Array.from(new Set(need.map(function (r) { return r.postal; })));
    var i = 0;
    function worker() {
      if (i >= queue.length) return Promise.resolve();
      return geocode(queue[i++]).then(worker);
    }
    return Promise.all([worker(), worker(), worker(), worker()]).then(function () {
      var missed = 0;
      rows.forEach(function (r) {
        if (isNaN(r.lat) || isNaN(r.lng)) {
          var g = cache[r.postal];
          if (g) { r.lat = g.lat; r.lng = g.lng; r.address = r.address || g.address; } else missed++;
        }
      });
      state.all = rows.filter(function (r) { return !isNaN(r.lat) && !isNaN(r.lng); });
      spread(state.all);
      status((usingSample ? "Showing <b>sample data</b>. Connect your Google Sheet in js/config.js to show live reports." :
        "Showing <b>" + state.all.length + "</b> live reports. Refresh to see new ones.") +
        (missed ? " " + missed + " report(s) had a postal code that could not be found." : ""));
      refresh();
    });
  }).catch(function (e) {
    console.error(e);
    status("Could not load the reports. Check that <code>sheetCsvUrl</code> is the <b>Publish to web → CSV</b> link.");
  });
})();

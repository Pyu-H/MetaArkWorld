/* =====================================================================
   MetaArk World —— 像素地图渲染器
   Canvas 2D 像素风渲染：地形 / 地块 / 建筑 / 人气热力 / 悬停高亮
   ===================================================================== */
'use strict';

const Renderer = (() => {
  let cv, ctx, dpr = 1;
  let hover = null;      // 悬停地块
  let selected = null;   // 选中地块
  let filter = 'all';    // all | owned | rent | listed
  let showHeat = false;
  let t0 = 0;

  const T = World.TILE;

  function init(canvas) {
    cv = canvas;
    ctx = cv.getContext('2d');
    resize();
    window.addEventListener('resize', resize);

    cv.addEventListener('mousemove', (e) => {
      const p = pick(e);
      if (p !== hover) { hover = p; cv.style.cursor = p ? 'pointer' : 'crosshair'; draw(); }
    });
    cv.addEventListener('mouseleave', () => { hover = null; draw(); });
    cv.addEventListener('click', (e) => {
      const p = pick(e);
      if (p) { selected = p; Renderer.onSelect && Renderer.onSelect(p); }
    });

    // 动画循环（用于人气脉冲与海浪）
    (function loop(ts) { t0 = ts || 0; draw(); requestAnimationFrame(loop); })(0);
  }

  function resize() {
    if (!cv) return;
    const wrapW = cv.parentElement.clientWidth;
    const scale = Math.min(1, wrapW / (World.MAP_W * T));
    dpr = window.devicePixelRatio || 1;
    cv.width = World.MAP_W * T * dpr;
    cv.height = World.MAP_H * T * dpr;
    cv.style.width = '100%';
    cv.style.height = 'auto';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    cv._scale = scale;
  }

  function pick(e) {
    const r = cv.getBoundingClientRect();
    const sc = (World.MAP_W * T) / r.width;
    const x = Math.floor(((e.clientX - r.left) * sc) / T);
    const y = Math.floor(((e.clientY - r.top) * sc) / T);
    if (x < 0 || y < 0 || x >= World.MAP_W || y >= World.MAP_H) return null;
    return World.plotAt(x, y);
  }

  // ---------- 绘制 ----------
  function draw() {
    if (!ctx) return;
    const W = World.MAP_W * T, H = World.MAP_H * T;
    ctx.clearRect(0, 0, W, H);

    for (let y = 0; y < World.MAP_H; y++) {
      for (let x = 0; x < World.MAP_W; x++) {
        drawTile(World.plotAt(x, y));
      }
    }
    drawOverlay();
  }

  function drawTile(p) {
    const px = p.x * T, py = p.y * T;
    const dimmed = !matchFilter(p);

    // 基础地形色
    let base = World.TERRAIN[p.terrain].c;
    if (p.type === 1) base = shade(base, -12);           // 海域更暗
    if (p.type === 2) base = shade(base, 16);            // 空岛更亮

    // 人气热力覆盖
    if (showHeat) {
      const h = Math.min(1, (p.popularity - 100) / 500);
      base = mix(base, '#ff3b30', h * 0.62);
    }

    ctx.fillStyle = dimmed ? shade(base, -55) : base;
    ctx.fillRect(px, py, T, T);

    // 像素噪点质感（确定性，不闪烁）
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    for (let i = 0; i < 3; i++) {
      const n = ((p.id * 37 + i * 91) % 23);
      ctx.fillRect(px + (n % 5) * 5, py + ((n * 3) % 5) * 5, 3, 3);
    }

    // 地形符号
    ctx.font = '11px system-ui';
    ctx.globalAlpha = dimmed ? 0.25 : 0.55;
    ctx.fillText(World.TERRAIN[p.terrain].ico, px + 2, py + 12);
    ctx.globalAlpha = 1;

    // 网格线
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);

    // 空岛/海域特殊边框
    if (p.type === 2) { ctx.strokeStyle = 'rgba(160,120,255,0.5)'; ctx.strokeRect(px + 1.5, py + 1.5, T - 3, T - 3); }

    // 已铸造标记
    if (p.minted) {
      ctx.fillStyle = p.owner === 'me' ? 'rgba(255,176,32,0.88)' : 'rgba(61,220,151,0.82)';
      ctx.fillRect(px + T - 8, py + 2, 6, 6);
    }

    // 建筑图标
    if (p.buildings.length) {
      const shown = p.buildings.slice(0, 3);
      shown.forEach((b, i) => {
        const def = World.typeDef(b.typeId);
        if (!def) return;
        ctx.font = '13px system-ui';
        ctx.globalAlpha = dimmed ? 0.3 : 1;
        ctx.fillText(def.ico, px + 4 + i * 8, py + T - 5);
      });
      ctx.globalAlpha = 1;
      // 等级角标
      const maxLv = Math.max(...p.buildings.map((b) => b.level));
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(px + 2, py + T - 17, 15, 11);
      ctx.fillStyle = '#ffd166';
      ctx.font = 'bold 9px ui-monospace, monospace';
      ctx.fillText('L' + maxLv, px + 4, py + T - 8);
    }

    // 出租标记
    if (p.renter) {
      ctx.fillStyle = 'rgba(108,140,255,0.92)';
      ctx.fillRect(px + 2, py + 2, 6, 6);
    }
    if (p.listed) {
      ctx.fillStyle = 'rgba(38,208,206,0.92)';
      ctx.fillRect(px + T / 2 - 3, py + 2, 6, 6);
    }
  }

  /** 人气脉冲点：人气越高点越多 */
  function drawOverlay() {
    const now = performance.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 700);

    World.tiles.forEach((p) => {
      if (p.popularity < 160) return;
      const px = p.x * T, py = p.y * T;
      const cnt = Math.min(5, Math.floor((p.popularity - 100) / 90));
      ctx.globalAlpha = 0.14 + pulse * 0.16;
      ctx.fillStyle = '#ffe08a';
      for (let i = 0; i < cnt; i++) {
        const a = (i / cnt) * Math.PI * 2 + now / 1600;
        const r = T * 0.26;
        ctx.fillRect(px + T / 2 + Math.cos(a) * r - 1, py + T / 2 + Math.sin(a) * r - 1, 2, 2);
      }
    });
    ctx.globalAlpha = 1;

    // 悬停高亮
    if (hover) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(hover.x * T + 1, hover.y * T + 1, T - 2, T - 2);
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      ctx.fillRect(hover.x * T, hover.y * T, T, T);
    }
    // 选中
    if (selected) {
      ctx.strokeStyle = '#ffb020';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(selected.x * T + 1.5, selected.y * T + 1.5, T - 3, T - 3);
    }
  }

  // ---------- 工具 ----------
  function matchFilter(p) {
    if (filter === 'all') return true;
    if (filter === 'owned') return !!p.owner;
    if (filter === 'mine') return p.owner === 'me';
    if (filter === 'rent') return p.dailyRent > 0 || p.monthlyRent > 0;
    if (filter === 'listed') return p.listed;
    if (filter === 'free') return !p.owner;
    return true;
  }

  function hex2rgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgb2hex(r, g, b) {
    const f = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + f(r) + f(g) + f(b);
  }
  function shade(c, amt) {
    const [r, g, b] = hex2rgb(c);
    return rgb2hex(r + amt, g + amt, b + amt);
  }
  function mix(c1, c2, t) {
    const a = hex2rgb(c1), b = hex2rgb(c2);
    return rgb2hex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  }

  return {
    init,
    redraw: draw,
    setFilter(f) { filter = f; draw(); },
    setHeat(v) { showHeat = v; draw(); },
    getSelected() { return selected; },
    select(p) { selected = p; draw(); },
  };
})();

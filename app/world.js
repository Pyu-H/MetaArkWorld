/* =====================================================================
   MetaArk World —— 游戏世界状态与经济模型
   地图生成 / 地块属性 / 建筑定义 / 双币经济 / 结算规则
   ===================================================================== */
'use strict';

const World = (() => {
  // ================= 常量 =================
  const MAP_W = 34, MAP_H = 22, TILE = 26;

  const LAND_TYPE = { 0: { n: '大陆', en: 'Mainland', rar: 1.0, c: '#4a7c59' },
                      1: { n: '海域', en: 'Ocean', rar: 1.5, c: '#2b6cb0' },
                      2: { n: '空岛', en: 'SkyIsland', rar: 2.5, c: '#7c5cbf' } };

  const TERRAIN = { 0: { n: '平原', yield: 1.00, c: '#5c9e6b', ico: '🌾' },
                    1: { n: '火山', yield: 1.25, c: '#8b4a3a', ico: '🌋' },
                    2: { n: '冰川', yield: 1.15, c: '#5b8fa8', ico: '🧊' } };

  // 建筑类型（与 BuildingNFT.sol 的 _seedTypes 完全一致）
  const BUILDINGS = [
    { id: 0, n: '基础工坊', ico: '🔨', kind: '功能', cost: 500,  yield: 30, pop: 20,  maxLv: 5 },
    { id: 1, n: '初级矿场', ico: '⛏️', kind: '功能', cost: 800,  yield: 55, pop: 15,  maxLv: 5 },
    { id: 2, n: '零售商店', ico: '🏪', kind: '功能', cost: 700,  yield: 45, pop: 45,  maxLv: 5 },
    { id: 3, n: '农田',     ico: '🌱', kind: '功能', cost: 300,  yield: 18, pop: 10,  maxLv: 5 },
    { id: 4, n: '英雄雕像', ico: '🗿', kind: '装饰', cost: 1200, yield: 0,  pop: 80,  maxLv: 3 },
    { id: 5, n: '灯塔',     ico: '🗼', kind: '装饰', cost: 1500, yield: 0,  pop: 110, maxLv: 3 },
    { id: 6, n: '主题乐园', ico: '🎡', kind: '装饰', cost: 3000, yield: 0,  pop: 220, maxLv: 3 },
  ];
  const MATERIALS = [
    { id: 7, n: '木材', ico: '🪵' }, { id: 8, n: '矿石', ico: '🪨' },
    { id: 9, n: '能量核', ico: '⚡' }, { id: 10, n: '设计图', ico: '📜' },
  ];

  // 经济参数（与合约常量对齐）
  const ECON = {
    BURN_RATE: 0.05,        // 建造焚烧 5%
    TRADE_TAX: 0.03,        // 交易税 3%
    LANDLORD_SHARE: 0.90,   // 房东分成 90%
    PROTOCOL_SHARE: 0.10,   // 协议抽成 10%
    INFLATION_CAP: 0.03,    // 年通胀上限 3%
    DECAY_GRACE_DAYS: 7,    // 衰败宽限期
    DECAY_PER_WEEK: 0.25,   // 每 7 天衰减 25%
  };

  // ================= 地图生成 =================
  let seed = 20260214;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

  const tiles = [];   // 全部地块
  const plots = new Map(); // "x,y" -> plot

  (function genMap() {
    seed = 20260214;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        // 用噪声决定地形分布：中心偏大陆，边缘偏海/空岛
        const cx = x / MAP_W - 0.5, cy = y / MAP_H - 0.5;
        const d = Math.sqrt(cx * cx + cy * cy);
        const n = rnd();

        let landType;
        if (d > 0.40 && n > 0.72) landType = 2;        // 空岛（外圈且随机）
        else if (d > 0.30 && n > 0.45) landType = 1;   // 海域
        else landType = 0;                              // 大陆

        let terrain;
        const t = rnd();
        if (landType === 1) terrain = 1;                // 海域多为火山地貌
        else if (t > 0.82) terrain = 2;                 // 冰川
        else if (t > 0.58) terrain = 1;                 // 火山
        else terrain = 0;                               // 平原

        const plot = {
          id: tiles.length,
          x, y,
          type: landType,
          terrain,
          popularity: 100,
          slots: landType === 2 ? 6 : (landType === 1 ? 3 : 5),
          buildings: [],           // [{typeId, level, lastMaint}]
          listed: false,
          price: 0,
          owner: null,             // 账户 name
          renter: null,
          dailyRent: 0,
          monthlyRent: 0,
          minted: false,
          value: 0,
        };
        tiles.push(plot);
        plots.set(x + ',' + y, plot);
      }
    }
  })();

  // ================= 经济计算 =================

  /** 地块估值（与 LandNFT.estimateValue 同逻辑） */
  function estimateValue(p) {
    const base = 100;
    const byType = base * LAND_TYPE[p.type].rar;
    const byPop = byType * (100 + p.popularity) / 200;
    const bySlots = byPop * (100 + p.buildings.length * 20) / 100;
    return Math.round(bySlots);
  }

  /** 建筑有效日产出（含衰败），与 BuildingNFT.effectiveDailyYield 同逻辑 */
  function effectiveYield(p, b) {
    const def = BUILDINGS.find((x) => x.id === b.typeId);
    if (!def || !def.yield) return 0;
    let gross = def.yield * (100 + (b.level - 1) * 50) / 100;
    gross *= TERRAIN[p.terrain].yield;         // 地形加成
    gross *= (1 + p.popularity / 500);         // 人气加成
    return Math.round(gross * 100) / 100;
  }

  /** 地块总日产出 */
  function plotYield(p) {
    return p.buildings.reduce((s, b) => s + effectiveYield(p, b), 0);
  }

  /** 升级成本：buildCost * (lv+1) * 1.6 */
  function upgradeCost(typeId, level) {
    const def = BUILDINGS.find((x) => x.id === typeId);
    return Math.round(def.cost * (level + 1) * 1.6);
  }

  /** 维护费 */
  function maintenanceCost(typeId, level) {
    return 20 * level;
  }

  // ================= 世界统计 =================
  function stats() {
    const owned = tiles.filter((t) => t.owner);
    const rented = tiles.filter((t) => t.renter);
    const built = tiles.reduce((s, t) => s + t.buildings.length, 0);
    const dailyYield = owned.reduce((s, t) => s + plotYield(t), 0);
    return {
      totalTiles: tiles.length,
      minted: tiles.filter((t) => t.minted).length,
      owned: owned.length,
      rented: rented.length,
      built,
      dailyYield,
      avgPop: owned.length ? Math.round(owned.reduce((s, t) => s + t.popularity, 0) / owned.length) : 0,
    };
  }

  return {
    MAP_W, MAP_H, TILE, LAND_TYPE, TERRAIN, BUILDINGS, MATERIALS, ECON,
    tiles, plots,
    plotAt: (x, y) => plots.get(x + ',' + y),
    estimateValue, effectiveYield, plotYield, upgradeCost, maintenanceCost, stats,
    typeDef: (id) => BUILDINGS.find((b) => b.id === id) || MATERIALS.find((m) => m.id === id),
  };
})();

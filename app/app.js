/* =====================================================================
   MetaArk World —— 主应用
   串联：世界状态 → 链上交易 → 经济看板 → 交互反馈
   ===================================================================== */
'use strict';

const App = (() => {
  // ================= 全局状态 =================
  const S = {
    me: 'me',
    arkSupply: 1_000_000,
    arkBurned: 0,
    metaSupply: 50_000_000,
    metaTotal: 50_000_000,
    protoFee: 0,
    tradeTax: 0,
    tradeVolume: 0,
    rentVolume: 0,
    mintedCount: 0,
    maxTiles: 240,
    hardCap: 4096,
    dailyYieldSeries: [],
    hist: { ark: [], burned: [] },
  };

  let selected = null;
  let buildPick = null;

  // ================= 初始化 =================
  function boot() {
    // 账户
    Chain.addAccount('me', '我的钱包', { ark: 12_800, meta: 36_000, eth: 12.48 });
    Chain.addAccount('alice', 'Alice.eth', { ark: 8_400, meta: 4_200 });
    Chain.addAccount('bob', 'Bob.dao', { ark: 15_600, meta: 2_600 });
    Chain.addAccount('carol', 'Carol', { ark: 5_200, meta: 1_800 });
    Chain.addAccount('dave', 'Dave', { ark: 22_100, meta: 800 });

    seedWorld();
    Renderer.init(document.getElementById('mapCanvas'));
    Renderer.onSelect = onSelectPlot;
    bindUI();
    seedTxHistory();

    // 生成初始曲线数据
    for (let i = 0; i < 28; i++) {
      S.hist.ark.push(980_000 + Math.round(Math.sin(i / 3) * 12_000) + i * 620);
      S.hist.burned.push(Math.round(90 + i * 31 + Math.sin(i / 2) * 22));
    }

    refreshAll();
    toast('ok', '欢迎来到元界方舟', '已连接本地链 #31337');
    // 初始渲染 3 秒后自动落块，让区块浏览器有内容
    setTimeout(() => Chain.mineBlock(), 3000);
  }

  /** 预置世界：一部分地块已被其他玩家持有，形成真实经济体 */
  function seedWorld() {
    const seedLands = [
      { who: 'alice', pos: [[11, 9], [12, 9], [13, 10]], builds: [[2, 3], [0, 2]] },
      { who: 'bob', pos: [[17, 12], [18, 12], [16, 13], [19, 11]], builds: [[1, 2], [6, 1]] },
      { who: 'carol', pos: [[22, 7], [23, 8]], builds: [[4, 2]] },
      { who: 'dave', pos: [[8, 15], [9, 15], [10, 14]], builds: [[5, 1], [3, 3]] },
    ];

    seedLands.forEach((g) => {
      g.pos.forEach(([x, y], i) => {
        const p = World.plotAt(x, y);
        if (!p) return;
        p.minted = true;
        p.owner = g.who;
        S.mintedCount += 1;
        // 部分地块挂租
        if (i === 0) {
          p.dailyRent = 80 + Math.floor(Math.random() * 90);
          p.monthlyRent = Math.round(p.dailyRent * 25);
        }
        // 设置建筑
        g.builds.forEach(([tid, lv], bi) => {
          if (bi < p.slots && (i + bi) % 2 === 0) {
            p.buildings.push({ typeId: tid, level: lv, lastMaint: Date.now() });
            const def = World.typeDef(tid);
            p.popularity += def.pop;
          }
        });
        p.popularity = Math.min(700, p.popularity + Math.floor(Math.random() * 90));
        p.value = World.estimateValue(p);
      });
    });

    // 一些挂售地块
    [[14, 8], [21, 14], [25, 10]].forEach(([x, y], i) => {
      const p = World.plotAt(x, y);
      if (!p) return;
      p.minted = true; p.owner = ['alice', 'bob', 'dave'][i]; p.listed = true;
      p.price = 1800 + i * 900;
      p.value = World.estimateValue(p);
      S.mintedCount += 1;
    });
  }

  function seedTxHistory() {
    const samples = [
      ['alice', '建造', '零售商店 → 地块(11,9)', 700, 'ARK'],
      ['bob', '生产', '矿场产出结算', 55, 'ARK'],
      ['carol', '租赁', '场地日租收款', 90, 'ARK'],
      ['dave', '建造', '灯塔 → 地块(8,15)', 1500, 'ARK'],
    ];
    samples.forEach((s, i) => {
      const acc = Chain.acct(s[0]);
      Chain.send({
        from: acc.addr, method: s[1], args: [s[2]], value: 0,
        exec: () => ({ ok: true }),
      });
      const tx = Chain.txs[0];
      if (tx) { tx.note = s[2]; tx.amount = s[3]; tx.symbol = s[4]; tx.status = 'success'; tx.blockNumber = Chain.blockNumber - i; }
    });
  }

  // ================= 核心：链上结算 =================

  /** 购买土地 */
  function buyLand(p) {
    const me = Chain.acct('me');
    const price = p.price || World.estimateValue(p);
    const tax = Math.round(price * World.ECON.TRADE_TAX);

    if (!p.minted) {
      // 创世领取：需要支付铸造费
      const mintFee = Math.round(World.estimateValue(p) * 0.4);
      if (me.ark < mintFee) return toast('err', '余额不足', `需要 ${mintFee} ARK`);

      const r = Chain.send({
        from: me.addr, to: '0xMetaArk…Land', method: 'mintLand', value: mintFee,
        args: [`地块(${p.x},${p.y})`, `地形：${World.TERRAIN[p.terrain].n}`, `费率 ${mintFee} ARK`],
        exec: ({ from }) => {
          if (from.ark < mintFee) return { err: 'ARK 余额不足' };
          from.ark -= mintFee;
          // 铸造费 5% 焚烧
          const burn = Math.round(mintFee * World.ECON.BURN_RATE);
          S.arkSupply -= burn; S.arkBurned += burn;
          S.protoFee += mintFee - burn;
          p.minted = true; p.owner = 'me';
          S.mintedCount += 1;
          Chain.pushLog({ ev: 'LandMinted', land: `(${p.x},${p.y})`, to: me.addr, burn });
          return { note: `铸造地块(${p.x},${p.y})，焚烧 ${burn} ARK`, amount: mintFee, symbol: 'ARK' };
        },
      });
      if (!r.ok) return toast('err', '交易失败', r.err);
      toast('ok', '创世地块已铸造', `地块(${p.x},${p.y}) 已上链，焚烧 ${Math.round(mintFee * 0.05)} ARK`);
    } else {
      // 二级市场购买
      const total = price + tax;
      if (me.ark < total) return toast('err', '余额不足', `需要 ${total} ARK（含 3% 税）`);
      const seller = Chain.acct(p.owner);

      const r = Chain.send({
        from: me.addr, to: '0xMetaArk…Market', method: 'buyLand',
        args: [`地块(${p.x},${p.y})`, `地价 ${price} + 税 ${tax} ARK`],
        exec: ({ from }) => {
          if (from.ark < total) return { err: 'ARK 余额不足' };
          from.ark -= total;
          if (seller) seller.ark += price;
          S.arkSupply -= tax; S.arkBurned += tax;   // 税进燃烧池
          S.tradeTax += tax; S.tradeVolume += price;
          p.owner = 'me'; p.listed = false; p.price = 0;
          Chain.pushLog({ ev: 'LandSold', land: `(${p.x},${p.y})`, to: me.addr, price, tax });
          return { note: `购入地块(${p.x},${p.y})，含 3% 交易税 ${tax} ARK`, amount: total, symbol: 'ARK' };
        },
      });
      if (!r.ok) return toast('err', '交易失败', r.err);
      toast('ok', '土地成交', `已购入地块(${p.x},${p.y})，交易税 ${tax} ARK 进入燃烧池`);
    }
    refreshAll();
    if (selected === p) onSelectPlot(p);
  }

  /** 建造 */
  function buildOn(p, typeId) {
    const me = Chain.acct('me');
    const def = World.typeDef(typeId);
    if (p.owner !== 'me') return toast('err', '无权建造', '请先购买该地块');
    if (p.buildings.length >= p.slots) return toast('err', '槽位已满', `该地块仅 ${p.slots} 个建筑槽位`);
    if (p.buildings.some((b) => b.typeId === typeId)) return toast('warn', '已建造', '同类建筑请使用升级');

    const cost = def.cost;
    if (me.ark < cost) return toast('err', '余额不足', `需要 ${cost} ARK`);

    const r = Chain.send({
      from: me.addr, to: '0xMetaArk…Building', method: 'build', args: [def.n, `地块(${p.x},${p.y})`],
      exec: ({ from }) => {
        if (from.ark < cost) return { err: 'ARK 余额不足' };
        from.ark -= cost;
        const burn = Math.round(cost * World.ECON.BURN_RATE);
        S.arkSupply -= burn; S.arkBurned += burn;
        S.protoFee += cost - burn;
        p.buildings.push({ typeId, level: 1, lastMaint: Date.now() });
        p.popularity = Math.min(1000, p.popularity + def.pop);
        p.value = World.estimateValue(p);
        Chain.pushLog({ ev: 'Built', land: `(${p.x},${p.y})`, building: def.n, burn });
        return { note: `建造${def.n}，焚烧 ${burn} ARK（5%）`, amount: cost, symbol: 'ARK' };
      },
    });
    if (!r.ok) return toast('err', '交易失败', r.err);
    toast('ok', `${def.n} 建造成功`, `消耗 ${cost} ARK，其中 ${Math.round(cost * 0.05)} ARK 焚烧`);
    refreshAll();
    onSelectPlot(p);
  }

  /** 升级 */
  function upgradeOn(p, typeId) {
    const me = Chain.acct('me');
    const b = p.buildings.find((x) => x.typeId === typeId);
    const def = World.typeDef(typeId);
    if (!b) return toast('err', '尚未建造', '请先建造该建筑');
    if (b.level >= def.maxLv) return toast('warn', `${def.n} 已满级`, `最高 ${def.maxLv} 级`);

    const cost = World.upgradeCost(typeId, b.level);
    if (me.ark < cost) return toast('err', '余额不足', `需要 ${cost} ARK`);

    const r = Chain.send({
      from: me.addr, to: '0xMetaArk…Building', method: 'upgrade',
      args: [`${def.n} Lv${b.level}→Lv${b.level + 1}`, `地块(${p.x},${p.y})`],
      exec: ({ from }) => {
        if (from.ark < cost) return { err: 'ARK 余额不足' };
        from.ark -= cost;
        const burn = Math.round(cost * World.ECON.BURN_RATE);
        S.arkSupply -= burn; S.arkBurned += burn;
        S.protoFee += cost - burn;
        b.level += 1;
        b.lastMaint = Date.now();
        p.popularity = Math.min(1000, p.popularity + Math.floor(def.pop / 2));
        p.value = World.estimateValue(p);
        Chain.pushLog({ ev: 'Upgraded', land: `(${p.x},${p.y})`, building: def.n, level: b.level, burn });
        return { note: `${def.n} 升至 Lv${b.level}，焚烧 ${burn} ARK`, amount: cost, symbol: 'ARK' };
      },
    });
    if (!r.ok) return toast('err', '交易失败', r.err);
    toast('ok', `升级成功 Lv${b.level}`, `产出提升至 ${World.effectiveYield(p, b).toFixed(1)} ARK/日`);
    refreshAll();
    onSelectPlot(p);
  }

  /** 维护 */
  function maintainOn(p, typeId) {
    const me = Chain.acct('me');
    const b = p.buildings.find((x) => x.typeId === typeId);
    const def = World.typeDef(typeId);
    if (!b) return;
    const cost = World.maintenanceCost(typeId, b.level);
    if (me.ark < cost) return toast('err', '余额不足', `需要 ${cost} ARK`);

    const r = Chain.send({
      from: me.addr, to: '0xMetaArk…Building', method: 'maintain',
      args: [`${def.n} 维护`, `消耗 ${cost} ARK`],
      exec: ({ from }) => {
        if (from.ark < cost) return { err: 'ARK 余额不足' };
        from.ark -= cost;
        S.protoFee += cost;
        b.lastMaint = Date.now();
        Chain.pushLog({ ev: 'Maintained', land: `(${p.x},${p.y})`, building: def.n });
        return { note: `${def.n} 维护完成，产出恢复`, amount: cost, symbol: 'ARK' };
      },
    });
    if (!r.ok) return toast('err', '交易失败', r.err);
    toast('ok', '维护完成', `${def.n} 产出已完全恢复`);
    refreshAll();
    onSelectPlot(p);
  }

  /** 挂租 */
  function setRent(p, daily, monthly) {
    const me = Chain.acct('me');
    if (p.owner !== 'me') return toast('err', '无权操作', '只有地主可以设置租金');
    const r = Chain.send({
      from: me.addr, to: '0xMetaArk…Land', method: 'setRent',
      args: [`地块(${p.x},${p.y})`, `日租 ${daily} / 月租 ${monthly} ARK`],
      exec: () => {
        p.dailyRent = daily; p.monthlyRent = monthly;
        Chain.pushLog({ ev: 'RentConfigured', land: `(${p.x},${p.y})`, daily, monthly });
        return { note: `设置租金 ${daily} ARK/日`, amount: daily, symbol: 'ARK' };
      },
    });
    if (!r.ok) return toast('err', '交易失败', r.err);
    toast('ok', '租金已设置', `日租 ${daily} ARK · 月租 ${monthly} ARK`);
    refreshAll();
    onSelectPlot(p);
  }

  /** 挂售 */
  function listLand(p, price) {
    const me = Chain.acct('me');
    if (p.owner !== 'me') return toast('err', '无权操作', '只有地主可以挂售');
    const r = Chain.send({
      from: me.addr, to: '0xMetaArk…Market', method: 'listLand',
      args: [`地块(${p.x},${p.y})`, `挂单价 ${price} ARK`],
      exec: () => {
        p.listed = true; p.price = price;
        Chain.pushLog({ ev: 'Listed', land: `(${p.x},${p.y})`, price });
        return { note: `挂单 ${price} ARK`, amount: price, symbol: 'ARK' };
      },
    });
    if (!r.ok) return toast('err', '交易失败', r.err);
    toast('ok', '已挂单', `地块(${p.x},${p.y}) 以 ${price} ARK 挂售`);
    refreshAll();
    onSelectPlot(p);
  }

  /** 租用他人土地（消费场景） */
  function rentFrom(p, monthly) {
    const me = Chain.acct('me');
    const landlord = Chain.acct(p.owner);
    const amount = monthly ? p.monthlyRent : p.dailyRent;
    if (!amount) return toast('err', '不可租用', '该地块未设置租金');
    if (p.owner === 'me') return toast('err', '无法自租', '地主不能租用自己的地块');
    if (me.ark < amount) return toast('err', '余额不足', `需要 ${amount} ARK`);

    const landlordAmt = Math.round(amount * World.ECON.LANDLORD_SHARE);
    const protocolAmt = amount - landlordAmt;

    const r = Chain.send({
      from: me.addr, to: '0xMetaArk…Market', method: 'rentLand',
      args: [monthly ? '月租' : '日租', `地块(${p.x},${p.y}) 地主 ${p.owner}`],
      exec: ({ from }) => {
        if (from.ark < amount) return { err: 'ARK 余额不足' };
        from.ark -= amount;
        if (landlord) landlord.ark += landlordAmt;
        S.protoFee += protocolAmt;
        S.rentVolume += amount;
        p.renter = 'me';
        Chain.pushLog({ ev: 'RentPaid', land: `(${p.x},${p.y})`, amount, landlordAmt, protocolAmt });
        return { note: `支付租金 ${amount} ARK，地主得 ${landlordAmt}（90%）`, amount, symbol: 'ARK' };
      },
    });
    if (!r.ok) return toast('err', '交易失败', r.err);
    toast('ok', '租赁成功', `${amount} ARK → 地主 ${landlordAmt} / 协议 ${protocolAmt}`);
    refreshAll();
    onSelectPlot(p);
  }

  /** 领取生产产出 */
  function claimYield(p) {
    const me = Chain.acct('me');
    if (p.owner !== 'me') return toast('err', '无权操作', '只有地主可领取产出');
    const amount = Math.round(World.plotYield(p) * 7); // 结算 7 天
    if (amount <= 0) return toast('warn', '暂无产出', '该地块没有功能型建筑');

    const r = Chain.send({
      from: me.addr, to: '0xMetaArk…Building', method: 'claimProduction',
      args: [`地块(${p.x},${p.y})`, `结算 7 日产出`],
      exec: ({ from }) => {
        from.ark += amount;
        from.materials = from.materials || {};
        from.materials[7] = (from.materials[7] || 0) + 3;   // 木材
        from.materials[8] = (from.materials[8] || 0) + 2;   // 矿石
        Chain.pushLog({ ev: 'MaterialClaimed', land: `(${p.x},${p.y})`, amount });
        return { note: `领取 7 日产出 + 材料（木材x3 矿石x2）`, amount, symbol: 'ARK' };
      },
    });
    if (!r.ok) return toast('err', '交易失败', r.err);
    toast('ok', '产出已领取', `+${amount} ARK，并发放材料木材x3 矿石x2`);
    refreshAll();
    onSelectPlot(p);
  }

  function onSelectPlot(p) {
    selected = p;
    Renderer.select(p);
    renderDetail(p);
  }

  // ================= 渲染：地块详情 =================
  function renderDetail(p) {
    const el = document.getElementById('landDetail');
    if (!p) {
      el.innerHTML = `<div class="land-empty"><div class="big">🗺️</div>点击地图上的任意地块<br>查看详情并开始经营</div>`;
      return;
    }
    const ownerName = p.owner ? (p.owner === 'me' ? '我' : Chain.acct(p.owner).label) : '未铸造';
    const isMine = p.owner === 'me';
    const val = World.estimateValue(p);
    const yld = World.plotYield(p);
    const popPct = Math.min(100, (p.popularity / 700) * 100);

    let actions = '';
    if (!p.minted) {
      const fee = Math.round(val * 0.4);
      actions = `<button class="btn pri full" onclick="App.buyLand(App.sel())">🏛️ 铸造创世地块 · ${fee} ARK</button>`;
    } else if (!p.owner) {
      actions = `<button class="btn pri full" onclick="App.buyLand(App.sel())">💰 购买该地块</button>`;
    } else if (isMine) {
      actions = `
        <div class="flex" style="gap:8px;flex-wrap:wrap">
          <button class="btn pri sm" onclick="App.openBuild()">🔨 建造</button>
          <button class="btn cy sm" onclick="App.openRent()">📋 挂租</button>
          <button class="btn sm" onclick="App.openList()">🏷️ 挂售</button>
          <button class="btn sm" onclick="App.claimYield(App.sel())">📦 领取产出</button>
        </div>`;
    } else {
      const dr = p.dailyRent || 0;
      actions = dr
        ? `<div class="flex" style="gap:8px">
             <button class="btn cy sm" onclick="App.rentFrom(App.sel(),false)">🏠 日租 ${dr} ARK</button>
             <button class="btn sm" onclick="App.rentFrom(App.sel(),true)">📅 月租 ${p.monthlyRent} ARK</button>
           </div>`
        : `<div class="muted" style="font-size:12.5px">该地块暂未开放租赁</div>`;
    }

    const bl = p.buildings.length
      ? p.buildings.map((b) => {
          const def = World.typeDef(b.typeId);
          const ye = World.effectiveYield(p, b);
          const decayed = b.lastMaint && Date.now() - b.lastMaint > 30 * 24 * 3600 * 1000;
          return `<div class="kv"><span class="k">${def.ico} ${def.n}</span>
            <span class="v">Lv${b.level}${ye ? ` · ${ye.toFixed(1)} ARK/日` : ' · 装饰'}</span></div>`;
        }).join('')
      : `<div class="muted" style="font-size:12.5px;padding:8px 0">尚无建筑，${isMine ? '点击「建造」开始开发' : '地主尚未开发'}</div>`;

    el.innerHTML = `
      <div class="card-h">
        <div>
          <h3>地块 (${p.x}, ${p.y})</h3>
          <div class="sub">${World.LAND_TYPE[p.type].n} · ${World.TERRAIN[p.terrain].n} · 稀有度 ${World.LAND_TYPE[p.type].rar}x</div>
        </div>
        <span class="pill ${isMine ? 'warn' : p.owner ? 'info' : 'ok'}">${ownerName}</span>
      </div>
      <div class="card-b">
        <div class="kv"><span class="k">人气值</span><span class="v" style="color:var(--ark)">${p.popularity}</span></div>
        <div class="bar"><i style="width:${popPct}%;background:linear-gradient(90deg,var(--ark),#ff6b35)"></i></div>
        <div class="kv" style="margin-top:10px"><span class="k">建筑槽位</span><span class="v">${p.buildings.length} / ${p.slots}</span></div>
        <div class="bar"><i style="width:${(p.buildings.length / p.slots) * 100}%;background:var(--accent)"></i></div>
        <div class="kv" style="margin-top:10px"><span class="k">估值</span><span class="v" style="color:var(--ark)">${Chain.fmtInt(val)} ARK</span></div>
        <div class="kv"><span class="k">日产出</span><span class="v" style="color:var(--up)">${yld.toFixed(1)} ARK</span></div>
        ${p.dailyRent ? `<div class="kv"><span class="k">租金</span><span class="v">${p.dailyRent}/日 · ${p.monthlyRent}/月</span></div>` : ''}
        ${p.listed ? `<div class="kv"><span class="k">挂售价</span><span class="v" style="color:var(--meta)">${Chain.fmtInt(p.price)} ARK</span></div>` : ''}
        ${p.renter ? `<div class="kv"><span class="k">当前租客</span><span class="v">${p.renter === 'me' ? '我' : p.renter}</span></div>` : ''}
        <div style="margin:14px 0 8px;font-size:12px;color:var(--txt-2)">建筑列表</div>
        ${bl}
        <div style="margin-top:15px">${actions}</div>
      </div>`;
  }

  // ================= 渲染：经济看板 =================
  function renderDashboard() {
    const st = World.stats();
    const me = Chain.acct('me');

    set('statArk', Chain.fmtInt(Math.round(S.arkSupply)));
    set('statBurned', Chain.fmtInt(Math.round(S.arkBurned)));
    set('statMeta', Chain.fmtInt(Math.round(S.metaSupply)));
    set('statLands', `${st.minted} / ${S.maxTiles}`);
    set('statBuilt', st.built);
    set('statYield', st.dailyYield.toFixed(0));

    set('myArk', Chain.fmtNum(me.ark));
    set('myMeta', Chain.fmtNum(me.meta));
    set('myLands', World.tiles.filter((t) => t.owner === 'me').length);
    set('myYield', World.tiles.filter((t) => t.owner === 'me').reduce((s, t) => s + World.plotYield(t), 0).toFixed(1));

    // 燃烧率
    const burnRate = S.arkSupply > 0 ? (S.arkBurned / (S.arkSupply + S.arkBurned)) * 100 : 0;
    set('burnRate', burnRate.toFixed(2) + '%');
    set('protoFee', Chain.fmtInt(Math.round(S.protoFee)));
    set('rentVol', Chain.fmtInt(Math.round(S.rentVolume)));
    set('tradeVol', Chain.fmtInt(Math.round(S.tradeVolume)));

    renderEconomyChart();
    renderSectors();
    renderTxFeed();
    renderHoldings();
    renderBlocks();
    renderLogs();
    renderMinterList();
  }

  /** 双币供应量曲线 */
  function renderEconomyChart() {
    const cv = document.getElementById('econChart');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.parentElement.clientWidth, H = 210;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = '100%'; cv.style.height = H + 'px';
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    const pad = { l: 46, r: 12, t: 14, b: 22 };
    const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;

    // 追加当前值
    const arkSeries = S.hist.ark.slice(-27).concat(Math.round(S.arkSupply));
    const burnSeries = S.hist.burned.slice(-27).concat(Math.round(S.arkBurned));

    const maxArk = Math.max(...arkSeries) * 1.02;
    const minArk = Math.min(...arkSeries) * 0.98;
    const maxBurn = Math.max(...burnSeries) * 1.15 || 1;

    // 网格
    c.strokeStyle = '#1a2540'; c.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (ch / 4) * i;
      c.beginPath(); c.moveTo(pad.l, y); c.lineTo(W - pad.r, y); c.stroke();
      c.fillStyle = '#5f7093'; c.font = '10px ui-monospace, monospace'; c.textAlign = 'right';
      c.fillText(Chain.fmtInt(Math.round(maxArk - ((maxArk - minArk) / 4) * i)), pad.l - 7, y + 3);
    }

    const px = (i) => pad.l + (cw / (arkSeries.length - 1)) * i;

    // $ARK 面积
    const grad = c.createLinearGradient(0, pad.t, 0, pad.t + ch);
    grad.addColorStop(0, 'rgba(255,176,32,0.34)');
    grad.addColorStop(1, 'rgba(255,176,32,0.01)');
    c.beginPath();
    arkSeries.forEach((v, i) => {
      const y = pad.t + ch - ((v - minArk) / (maxArk - minArk)) * ch;
      i === 0 ? c.moveTo(px(i), y) : c.lineTo(px(i), y);
    });
    c.lineTo(px(arkSeries.length - 1), pad.t + ch);
    c.lineTo(px(0), pad.t + ch);
    c.closePath();
    c.fillStyle = grad; c.fill();

    c.beginPath();
    arkSeries.forEach((v, i) => {
      const y = pad.t + ch - ((v - minArk) / (maxArk - minArk)) * ch;
      i === 0 ? c.moveTo(px(i), y) : c.lineTo(px(i), y);
    });
    c.strokeStyle = '#ffb020'; c.lineWidth = 2; c.stroke();

    // 燃烧量线
    c.beginPath();
    burnSeries.forEach((v, i) => {
      const y = pad.t + ch - (v / maxBurn) * ch * 0.82;
      i === 0 ? c.moveTo(px(i), y) : c.lineTo(px(i), y);
    });
    c.strokeStyle = '#ff6b35'; c.lineWidth = 1.6; c.setLineDash([4, 3]); c.stroke();
    c.setLineDash([]);

    // 当前点
    const lx = px(arkSeries.length - 1), ly = pad.t + ch - ((arkSeries[arkSeries.length - 1] - minArk) / (maxArk - minArk)) * ch;
    c.beginPath(); c.arc(lx, ly, 4, 0, 7); c.fillStyle = '#ffb020'; c.fill();
    c.strokeStyle = '#0c1220'; c.lineWidth = 2; c.stroke();

    // 图例
    c.font = '10.5px system-ui'; c.textAlign = 'left';
    c.fillStyle = '#ffb020'; c.fillRect(pad.l, 4, 9, 3);
    c.fillStyle = '#9aabc9'; c.fillText('$ARK 流通量', pad.l + 14, 7.5);
    c.fillStyle = '#ff6b35'; c.fillRect(pad.l + 96, 4, 9, 3);
    c.fillStyle = '#9aabc9'; c.fillText('累计燃烧', pad.l + 110, 7.5);
  }

  /** 产业分布 */
  function renderSectors() {
    const el = document.getElementById('sectors');
    if (!el) return;
    const counts = {};
    World.tiles.forEach((p) => p.buildings.forEach((b) => {
      counts[b.typeId] = (counts[b.typeId] || 0) + 1;
    }));
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    const rows = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => {
        const def = World.typeDef(Number(id));
        const pct = (n / total) * 100;
        return `<div style="margin-bottom:11px">
          <div class="between" style="font-size:12.5px;margin-bottom:4px">
            <span>${def.ico} ${def.n}</span>
            <span class="mono" style="color:var(--txt-2)">${n} 座 · ${pct.toFixed(0)}%</span>
          </div>
          <div class="bar"><i style="width:${pct}%;background:linear-gradient(90deg,var(--accent),var(--meta))"></i></div>
        </div>`;
      }).join('');
    el.innerHTML = rows || '<div class="empty">暂无建筑</div>';
  }

  /** 交易流水 */
  function renderTxFeed() {
    const el = document.getElementById('txFeed');
    if (!el) return;
    const IconFor = { 购买: '🏛️', 建造: '🔨', 升级: '⬆️', 租赁: '🏠', 挂租: '📋', 挂售: '🏷️', 生产: '📦', 维护: '🔧', 铸造: '✨' };
    const ColorFor = { 购买: '#ffb020', 建造: '#6c8cff', 升级: '#26d0ce', 租赁: '#3ddc97', 挂租: '#6c8cff', 挂售: '#26d0ce', 生产: '#3ddc97', 维护: '#ff6b35', 铸造: '#ffb020' };

    const rows = Chain.txs.slice(0, 24).map((t) => {
      const col = ColorFor[t.method] || '#6c8cff';
      const ico = IconFor[t.method] || '📄';
      const st = t.status === 'failed' ? '<span class="pill err">失败</span>' : '<span class="pill ok">成功</span>';
      return `<div class="txrow">
        <div class="ic" style="background:${col}22;color:${col}">${ico}</div>
        <div class="bd">
          <div class="t1">${t.method}${t.note ? ' · ' + t.note : ''}</div>
          <div class="t2">${Chain.short(t.hash, 5)} · blk ${t.blockNumber || '—'} · ${Chain.timeAgo(t.timestamp)}</div>
        </div>
        <div class="amt" style="color:${t.symbol === 'ARK' ? 'var(--ark)' : 'var(--meta)'}">
          ${t.amount ? Chain.fmtInt(t.amount) + ' ' + t.symbol : ''}
          <span class="x">${st}</span>
        </div>
      </div>`;
    }).join('');
    el.innerHTML = rows || '<div class="empty">暂无交易</div>';
  }

  /** 我的资产 */
  function renderHoldings() {
    const el = document.getElementById('holdings');
    if (!el) return;
    const mine = World.tiles.filter((t) => t.owner === 'me');
    if (!mine.length) {
      el.innerHTML = '<div class="empty">你还没有土地<br><span class="muted">点击地图上未被铸造的地块开始</span></div>';
      return;
    }
    el.innerHTML = mine.map((p) => {
      const val = World.estimateValue(p);
      const yld = World.plotYield(p);
      return `<div class="kv" style="cursor:pointer" onclick="App.focus(${p.x},${p.y})">
        <span class="k">地块(${p.x},${p.y}) ${World.TERRAIN[p.terrain].ico}
          ${p.listed ? '<span class="pill info" style="margin-left:6px">挂售中</span>' : ''}
          ${p.renter ? '<span class="pill warn" style="margin-left:6px">已出租</span>' : ''}
        </span>
        <span class="v">${Chain.fmtInt(val)} ARK · ${yld.toFixed(0)}/日</span>
      </div>`;
    }).join('');
  }

  /** 区块列表 */
  function renderBlocks() {
    const el = document.getElementById('blockList');
    if (!el) return;
    const rows = Chain.blocks.slice(-14).reverse().map((b) => `
      <tr>
        <td style="color:var(--meta)">#${Chain.fmtInt(b.number)}</td>
        <td class="muted">${Chain.short(b.hash, 6)}</td>
        <td>${b.txCount}</td>
        <td class="muted">${Chain.fmtInt(b.gasUsed)}</td>
        <td class="muted">${b.size} B</td>
        <td class="muted nowrap">${new Date(b.timestamp * 1000).toLocaleTimeString('zh-CN')}</td>
      </tr>`).join('');
    el.innerHTML = rows || '<tr><td colspan="6" class="empty">等待出块…</td></tr>';
  }

  /** 事件日志 */
  function renderLogs() {
    const el = document.getElementById('logList');
    if (!el) return;
    const evColor = { LandMinted: '#ffb020', Built: '#6c8cff', Upgraded: '#26d0ce', LandSold: '#3ddc97',
      RentPaid: '#3ddc97', RentConfigured: '#6c8cff', Listed: '#26d0ce', Maintained: '#ff6b35', MaterialClaimed: '#3ddc97' };
    const rows = Chain.logs.slice(0, 26).map((l) => `
      <div class="txrow">
        <div class="ic" style="background:${(evColor[l.ev] || '#6c8cff')}22;color:${evColor[l.ev] || '#6c8cff'};font-size:10px">◈</div>
        <div class="bd">
          <div class="t1" style="font-family:var(--mono);font-size:12px">${l.ev}</div>
          <div class="t2">${l.land || ''} ${l.building ? '· ' + l.building : ''}${l.burn ? ' · 焚烧 ' + l.burn : ''}${l.amount ? ' · ' + Chain.fmtInt(l.amount) + ' ARK' : ''}${l.price ? ' · ' + Chain.fmtInt(l.price) + ' ARK' : ''}${l.daily ? ' · ' + l.daily + '/日' : ''}</div>
        </div>
        <div class="amt"><span class="x">blk ${l.blockNumber}</span></div>
      </div>`).join('');
    el.innerHTML = rows || '<div class="empty">暂无链上事件</div>';
  }

  /** Minter 通胀额度 */
  function renderMinterList() {
    const el = document.getElementById('minterList');
    if (!el) return;
    const cap = Math.round(S.arkSupply * World.ECON.INFLATION_CAP);
    const issued = Math.round(cap * 0.62);
    const pct = (issued / cap) * 100;
    el.innerHTML = `
      <div class="kv"><span class="k">年度通胀上限</span><span class="v">${Chain.fmtInt(cap)} ARK</span></div>
      <div class="bar"><i style="width:${pct}%;background:linear-gradient(90deg,var(--up),var(--ark))"></i></div>
      <div class="kv" style="margin-top:9px"><span class="k">本周期已增发</span><span class="v">${Chain.fmtInt(issued)} ARK</span></div>
      <div class="kv"><span class="k">剩余额度</span><span class="v" style="color:var(--up)">${Chain.fmtInt(cap - issued)} ARK</span></div>
      <div class="kv"><span class="k">授权 Minter</span><span class="v">2 个</span></div>
      <div style="margin-top:11px;font-size:12px;color:var(--txt-2);line-height:1.7">
        仅 <code>BuildingNFT</code> 与任务系统可增发，<br>单笔超额将被 <code>inflation cap exceeded</code> 拦截。
      </div>`;
  }

  // ================= 刷新 =================
  function refreshAll() {
    renderDashboard();
    Renderer.redraw();
    if (selected) renderDetail(selected);
    updateWallet();
  }

  function updateWallet() {
    const me = Chain.acct('me');
    set('wArk', Chain.fmtNum(me.ark, 0));
    set('wMeta', Chain.fmtNum(me.meta, 0));
    set('wEth', me.eth.toFixed(3));
    set('wBlock', Chain.fmtInt(Chain.blockNumber));
  }

  function set(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }

  // ================= 交互 =================
  function bindUI() {
    // 导航
    document.querySelectorAll('.nav button').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('.nav button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        document.querySelectorAll('.page').forEach((p) => p.classList.remove('on'));
        document.getElementById('page-' + b.dataset.p).classList.add('on');
        if (b.dataset.p === 'economy') setTimeout(renderEconomyChart, 30);
      };
    });

    // 地图筛选
    document.querySelectorAll('.chip[data-f]').forEach((c) => {
      c.onclick = () => {
        document.querySelectorAll('.chip[data-f]').forEach((x) => x.classList.remove('on'));
        c.classList.add('on');
        Renderer.setFilter(c.dataset.f);
      };
    });

    // 热力图
    const hb = document.getElementById('heatToggle');
    if (hb) hb.onclick = () => {
      const on = !hb.classList.contains('on');
      hb.classList.toggle('on', on);
      Renderer.setHeat(on);
    };

    // 模态关闭
    document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeModal; });
    document.getElementById('mask').onclick = (e) => { if (e.target.id === 'mask') closeModal(); };

    // 链事件
    Chain.on('tx', () => { renderTxFeed(); renderLogs(); });
    Chain.on('block', () => { renderBlocks(); updateWallet(); });
    Chain.on('log', renderLogs);

    // 周期性刷新交易时间显示
    setInterval(() => { renderTxFeed(); renderBlocks(); updateWallet(); }, 15000);

    // 懒出块：模拟持续链上活动
    setInterval(() => {
      if (Math.random() > 0.72) Chain.mineBlock();
    }, 9000);

    // 自动涨落的代币供应（模拟生产铸币）
    setInterval(() => {
      const inc = Math.round(60 + Math.random() * 220);
      S.arkSupply += inc;
      S.protoFee += Math.round(inc * 0.08);
      renderDashboard();
    }, 8000);
  }

  // ---------- 模态 ----------
  function openModal(title, bodyHtml, footerHtml) {
    document.getElementById('mTitle').textContent = title;
    document.getElementById('mBody').innerHTML = bodyHtml;
    document.getElementById('mFoot').innerHTML = footerHtml || '';
    document.getElementById('mask').classList.add('on');
  }
  function closeModal() { document.getElementById('mask').classList.remove('on'); if (sel()) onSelectPlot(sel()); }

  /** 建造模态 */
  function openBuild() {
    const p = selected;
    if (!p || p.owner !== 'me') return toast('err', '请先选择自己的地块');
    const me = Chain.acct('me');
    const free = p.slots - p.buildings.length;
    const items = World.BUILDINGS.map((b) => {
      const owned = p.buildings.some((x) => x.typeId === b.id);
      const afford = me.ark >= b.cost;
      return `<div class="bitem ${owned ? 'sel' : ''}" ${owned || !afford ? '' : `onclick="App.pickBuild(${b.id})"`}
        style="${owned ? 'opacity:.5' : (!afford ? 'opacity:.42' : '')};margin-bottom:7px">
        <div class="ico">${b.ico}</div>
        <div style="flex:1">
          <div class="nm">${b.n} <span class="muted" style="font-size:11px">${b.kind}</span></div>
          <div class="cs">${b.cost} ARK · 产量 ${b.yield}/日 · 人气 +${b.pop}${owned ? ' · 已建造' : ''}${!afford ? ' · 余额不足' : ''}</div>
        </div>
      </div>`;
    }).join('');

    openModal(`🔨 建造 · 地块(${p.x},${p.y})`,
      `<div class="hint mb14">剩余槽位 <b style="color:var(--ark)">${free}</b> / ${p.slots} · 你的余额 <b class="c-ark">${Chain.fmtNum(me.ark, 0)} ARK</b>
        <br>建造将焚烧 5% 作为通缩，其余进入协议金库。</div>${items}`,
      `<button class="btn" onclick="App.closeModal()">取消</button>`);
  }

  function pickBuild(typeId) {
    buildPick = typeId;
    closeModal();
    buildOn(selected, typeId);
  }

  /** 挂租模态 */
  function openRent() {
    const p = selected;
    if (!p || p.owner !== 'me') return toast('err', '请先选择自己的地块');
    const val = World.estimateValue(p);
    const d = p.dailyRent || Math.max(20, Math.round(val * 0.03));
    const m = p.monthlyRent || d * 25;
    openModal(`📋 设置租金 · 地块(${p.x},${p.y})`,
      `<div class="hint mb14">租客支付的租金按 <b>地主 90% / 协议 10%</b> 自动分账，协议份额进入燃烧池。</div>
       <div class="row2">
         <div class="field"><label>日租金（ARK）</label><input id="inRentD" type="number" value="${d}" min="1"></div>
         <div class="field"><label>月租金（ARK）</label><input id="inRentM" type="number" value="${m}" min="1"></div>
       </div>
       <div class="hint">建议日租 ≈ 估值的 3%（当前估值 ${Chain.fmtInt(val)} ARK）</div>`,
      `<button class="btn" onclick="App.closeModal()">取消</button>
       <button class="btn cy" onclick="App.doRent()">确认挂租</button>`);
  }
  function doRent() {
    const d = Number(document.getElementById('inRentD').value);
    const m = Number(document.getElementById('inRentM').value);
    if (!(d > 0) || !(m > 0)) return toast('err', '请输入有效租金');
    closeModal();
    setRent(selected, Math.round(d), Math.round(m));
  }

  /** 挂售模态 */
  function openList() {
    const p = selected;
    if (!p || p.owner !== 'me') return toast('err', '请先选择自己的地块');
    const val = World.estimateValue(p);
    openModal(`🏷️ 挂售 · 地块(${p.x},${p.y})`,
      `<div class="hint mb14">成交时买方额外支付 <b>3% 交易税</b>，直接进入燃烧池。</div>
       <div class="field"><label>挂售价格（ARK）</label><input id="inPrice" type="number" value="${Math.round(val * 1.2)}" min="1"></div>
       <div class="hint">当前估值 ${Chain.fmtInt(val)} ARK · 建议溢价 10%~30%</div>`,
      `<button class="btn" onclick="App.closeModal()">取消</button>
       <button class="btn pri" onclick="App.doList()">确认挂售</button>`);
  }
  function doList() {
    const v = Number(document.getElementById('inPrice').value);
    if (!(v > 0)) return toast('err', '请输入有效价格');
    closeModal();
    listLand(selected, Math.round(v));
  }

  // ---------- Toast ----------
  function toast(type, title, msg) {
    const box = document.getElementById('toasts');
    const ico = { ok: '✅', err: '⛔', warn: '⚠️' }[type] || 'ℹ️';
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = `<span class="ti">${ico}</span><div><div style="font-weight:600">${title}</div>${msg ? `<div class="muted" style="font-size:12px">${msg}</div>` : ''}</div>`;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 4200);
  }

  function focus(x, y) {
    const p = World.plotAt(x, y);
    if (!p) return;
    selected = p; Renderer.select(p); onSelectPlot(p);
    document.querySelector('[data-p="world"]').click();
    document.getElementById('mapCanvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return {
    boot, refreshAll, buyLand, onSelectPlot, closeModal,
    openBuild, openRent, openList, pickBuild, doRent, doList,
    rentFrom, claimYield, focus,
    buildOn, upgradeOn, maintainOn, setRent, listLand,
    sel: () => selected,
    state: S,
  };
})();

window.addEventListener('DOMContentLoaded', App.boot);

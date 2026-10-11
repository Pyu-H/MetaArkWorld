/* =====================================================================
   MetaArk Chain Simulator
   浏览器内轻量区块链：账户 / Nonce / 交易 / Gas / 区块打包 / 事件日志
   用途：无需 MetaMask，也能完整演示「上链」的每一步与真实经济结算
   ===================================================================== */
'use strict';

const Chain = (() => {
  // ---------- 链状态 ----------
  let blockNumber = 18_204_336;
  let blockTime = Math.floor(Date.now() / 1000);
  const chainId = 31337;
  const gasPrice = 12;              // Gwei
  const BURN_POOL = '0x000000000000000000000000000000000000dEaD';

  const blocks = [];                // 区块列表
  const txs = [];                   // 全部交易
  const logs = [];                  // 事件日志
  let txNonce = 0;
  let blockTxBuf = [];

  // ---------- 账户 ----------
  const accounts = new Map();

  function mkAddr(seed) {
    // 用确定性方式生成合法 hex 地址
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    let out = '0x';
    let x = h;
    for (let i = 0; i < 40; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      out += ((x >>> 24) & 0xf).toString(16);
    }
    return out;
  }

  function addAccount(name, label, opts = {}) {
    const addr = mkAddr(name);
    const acc = {
      name,
      label,
      addr,
      ark: opts.ark || 0,
      meta: opts.meta || 0,
      eth: opts.eth !== undefined ? opts.eth : 12.48,
      nonce: 0,
      lands: [],
      buildings: {},   // landTokenId -> [typeId,...]
      materials: {},   // typeId -> amount
    };
    accounts.set(addr, acc);
    return acc;
  }

  // ---------- 事件 ----------
  const listeners = {};
  function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
  function emit(ev, data) { (listeners[ev] || []).forEach((f) => f(data)); }

  // ---------- 区块 ----------
  function mineBlock(maxTx = 6) {
    const take = blockTxBuf.splice(0, maxTx);
    if (!take.length && blocks.length) return blocks[blocks.length - 1];

    blockNumber += 1;
    blockTime += 2 + Math.floor(Math.random() * 11);
    const parent = blocks.length ? blocks[blocks.length - 1].hash : '0x' + '0'.repeat(64);

    // 伪哈希
    const seed = blockNumber + ':' + take.length + ':' + parent.slice(2, 10);
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    let hash = '0x';
    let x = h;
    for (let i = 0; i < 64; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; hash += ((x >>> 28) & 0xf).toString(16); }

    const blk = {
      number: blockNumber,
      hash,
      parentHash: parent,
      timestamp: blockTime,
      txCount: take.length,
      gasUsed: take.reduce((s, t) => s + t.gasUsed, 0),
      txs: take.map((t) => t.hash),
      miner: '0xMetaArk…Validator',
      size: 320 + take.length * 148,
    };
    blocks.push(blk);
    if (blocks.length > 60) blocks.shift();

    // 落块后回填确认数
    take.forEach((t) => { t.blockNumber = blockNumber; t.status = 'success'; });

    emit('block', blk);
    return blk;
  }

  // ---------- 交易 ----------
  /**
   * 提交一笔交易：校验 → 扣 Gas → 执行 → 进内存池 → 打包
   * @param {object} o { from, to, method, args, gas, value, exec }
   *   exec(callCtx) 返回 { ok, amount, symbol, note } —— 具体业务结算
   */
  function send(o) {
    const from = accounts.get(o.from);
    if (!from) return { ok: false, err: '账户不存在' };

    const gasUsed = o.gas || 21_000 + Math.floor(Math.random() * 42_000);
    const gasCostEth = (gasUsed * gasPrice) / 1e9;

    // 真实地校验 ETH 余额
    if (from.eth < gasCostEth) return { ok: false, err: 'ETH 不足以支付 Gas' };

    from.eth = +(from.eth - gasCostEth).toFixed(6);
    from.nonce += 1;

    const txHash = mkTxHash(from.addr, from.nonce, blockNumber);
    const tx = {
      hash: txHash,
      from: from.addr,
      fromName: from.name,
      to: o.to || null,
      method: o.method,
      args: o.args || [],
      nonce: from.nonce,
      gasUsed,
      gasPrice,
      gasCostEth,
      value: o.value || 0,
      timestamp: Math.floor(Date.now() / 1000),
      blockNumber: null,
      status: 'pending',
      note: '',
    };

    // 执行业务逻辑
    if (typeof o.exec === 'function') {
      const r = o.exec({ from, accounts, emit, BURN_POOL, chain: api });
      if (r && r.err) {
        tx.status = 'failed';
        tx.note = r.err;
        txs.unshift(tx);
        emit('tx', tx);
        return { ok: false, err: r.err, tx };
      }
      if (r) { tx.note = r.note || ''; tx.amount = r.amount; tx.symbol = r.symbol; }
    }

    txNonce += 1;
    txs.unshift(tx);
    if (txs.length > 300) txs.pop();
    emit('tx', tx);

    blockTxBuf.push(tx);
    // 攒够或随机落块
    if (blockTxBuf.length >= 3 || Math.random() > 0.45) mineBlock();

    return { ok: true, tx };
  }

  function mkTxHash(addr, nonce, blk) {
    const s = addr + nonce + blk + Date.now() + Math.random();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    let out = '0x';
    let x = h;
    for (let i = 0; i < 64; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out += ((x >>> 28) & 0xf).toString(16); }
    return out;
  }

  // ---------- 事件日志 ----------
  function pushLog(entry) {
    const log = {
      ...entry,
      blockNumber: blockNumber + 1,
      txHash: mkTxHash('log', logs.length, blockNumber).slice(0, 12),
      ts: Math.floor(Date.now() / 1000),
    };
    logs.unshift(log);
    if (logs.length > 200) logs.pop();
    emit('log', log);
  }

  // ---------- 对外 API ----------
  const api = {
    chainId, gasPrice, BURN_POOL,
    accounts,
    blocks, txs, logs,
    on, emit, send, mineBlock, pushLog, addAccount, mkAddr,

    get blockNumber() { return blockNumber; },
    get blockTime() { return blockTime; },
    set blockTime(v) { blockTime = v; },
    get pending() { return blockTxBuf.length; },

    acct(name) { return accounts.get(mkAddr(name)); },
    acctByAddr(a) { return accounts.get(a); },
    short(a, n = 4) { return a ? a.slice(0, 2 + n) + '…' + a.slice(-n) : ''; },
    fmtNum(v, d = 2) {
      if (v === undefined || v === null) return '—';
      const n = Number(v);
      return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    fmtInt(v) { return Number(v || 0).toLocaleString('en-US'); },
    timeAgo(ts) {
      const s = Math.floor(Date.now() / 1000) - ts;
      if (s < 60) return s + ' 秒前';
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
      return Math.floor(s / 3600) + ' 小时前';
    },
  };

  return api;
})();

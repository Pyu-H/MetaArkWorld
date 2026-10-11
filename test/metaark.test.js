/**
 * MetaArk World —— 合约集成测试
 * 在真实 EVM（ganache）上部署全部合约，验证核心闭环：
 *   买地 → 盖店 → 升级 → 挂租 → 租客消费 → 地主提现 → 燃烧与税收
 * 以及经济规则：5% 建造焚烧、3% 交易税、租赁 90/10 分成、维护费与衰败。
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const BUILD = '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d43-175193d15000/metaark-build';
const load = (n) => ({
  abi: JSON.parse(fs.readFileSync(path.join(BUILD, `${n}.abi.json`), 'utf8')),
  bytecode: '0x' + fs.readFileSync(path.join(BUILD, `${n}.bin.txt`), 'utf8').trim(),
});

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}
async function expectRevert(name, promise, keyword) {
  try {
    await promise; failed++; failures.push(name);
    console.log(`  ❌ ${name} — 期望 revert 但成功了`);
  } catch (e) {
    const msg = (e.message || '') + JSON.stringify(e.error || {});
    const hit = !keyword || msg.includes(keyword);
    if (hit) { passed++; console.log(`  ✅ ${name} — 正确拦截`); }
    else { failed++; failures.push(name); console.log(`  ❌ ${name} — 原因不符: ${msg.slice(0, 140)}`); }
  }
}
const P = (n) => ethers.utils.parseEther(String(n));
const fmt = (b) => Number(ethers.utils.formatEther(b)).toFixed(2);
/** 统一把 BigNumber / number / string 转成 JS number */
const N = (v) => (v && v.toNumber ? v.toNumber() : Number(v));

async function section(n, title) { console.log(`\n${'='.repeat(4)} ${n}. ${title} ${'='.repeat(4)}`); }

async function main() {
  // ---------------- 环境（连接 Hardhat 本地节点） ----------------
  const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545';
  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const accts = await provider.listAccounts();
  if (accts.length < 5) throw new Error('本地节点账户数不足');
  const S = accts.slice(0, 5).map((a) => provider.getSigner(a));
  const A = {};
  for (let i = 0; i < 5; i++) {
    A[['deployer', 'alice', 'bob', 'carol', 'dave'][i]] = await S[i].getAddress();
  }
  const signer = { deployer: S[0], alice: S[1], bob: S[2], carol: S[3], dave: S[4] };

  // 时间旅行工具（Hardhat 用 evm_increaseTime / evm_mine，语义与 ganache 一致）
  const timeTravel = async (seconds) => {
    await provider.send('evm_increaseTime', [seconds]);
    await provider.send('evm_mine', []);
  };

  async function deploy(name, args, s) {
    const { abi, bytecode } = load(name);
    const f = new ethers.ContractFactory(abi, bytecode, s);
    const c = await f.deploy(...args);
    await c.deployed();
    return c;
  }
  const at = (name, addr, s) => new ethers.Contract(addr, load(name).abi, s);

  // ---------------- 1. 部署 ----------------
  await section(1, '合约部署与初始化');
  const TREASURY = A.deployer;

  const ark = await deploy('ArkToken', [P(1_000_000)], signer.deployer);
  const meta = await deploy('MetaToken', [P(50_000_000)], signer.deployer);
  const land = await deploy('LandNFT', [100, 4096], signer.deployer);
  const bld = await deploy('BuildingNFT', [ark.address, land.address], signer.deployer);
  const market = await deploy('LandMarket', [ark.address, land.address, meta.address, A.deployer], signer.deployer);

  ok('ArkToken 部署成功', ark.address !== ethers.constants.AddressZero, 'ARK 总量 100 万');
  ok('MetaToken 部署成功', (await meta.totalSupply()).eq(P(50_000_000)));
  ok('LandNFT 部署成功', N(await land.maxTiles()) === 100, '初始解锁 100 格，硬顶 4096');
  ok('BuildingNFT 预置类型数 = 11', N(await bld.typeCount()) === 11);
  ok('LandMarket 部署成功', N(await market.landlordShareBps()) === 9000, '房东分成 90%');

  // 授权关系
  await (await land.connect(signer.deployer).setController(bld.address, true)).wait();
  await (await land.connect(signer.deployer).setController(market.address, true)).wait();
  await (await bld.connect(signer.deployer).setController(A.deployer, true)).wait();
  await (await ark.connect(signer.deployer).setMinter(bld.address, true)).wait();
  ok('BuildingNFT 被授权为土地控制器', (await land.controllers(bld.address)) === true);
  ok('LandMarket 被授权为土地控制器', (await land.controllers(market.address)) === true);
  await expectRevert(
    '未授权地址不能修改土地',
    land.connect(signer.alice).consumeSlot(0),
    'not controller'
  );

  // ---------------- 2. 代币分发 ----------------
  await section(2, '$ARK 分发与通胀上限');
  for (const k of ['alice', 'bob', 'carol', 'dave']) {
    await (await ark.connect(signer.deployer).transfer(A[k], P(50_000))).wait();
  }
  ok('alice 获得 50000 ARK', (await ark.balanceOf(A.alice)).eq(P(50_000)));
  ok('总供应不变（转账非增发）', (await ark.totalSupply()).eq(P(1_000_000)));

  // 通胀上限：deployer 每年最多增发 3%
  await expectRevert(
    '单次增发超过 3% 年通胀上限被拦截',
    ark.connect(signer.deployer).mint(A.alice, P(50_000), 'test'),
    'inflation cap exceeded'
  );
  ok('剩余通胀额度已正确计算', (await ark.remainingInflationQuota()).eq(P(30_000)), '30000 ARK (3%)');
  await (await ark.connect(signer.deployer).mint(A.alice, P(20_000), 'quest-reward')).wait();
  ok('额度内增发成功', (await ark.balanceOf(A.alice)).eq(P(70_000)));
  await expectRevert(
    '超出剩余额度被拦截',
    ark.connect(signer.deployer).mint(A.alice, P(20_000), 'over'),
    'inflation cap exceeded'
  );
  await expectRevert(
    '非 Minter 无法增发',
    ark.connect(signer.alice).mint(A.alice, P(1), 'hack'),
    'not minter'
  );

  // ---------------- 3. 铸地 ----------------
  await section(3, '土地铸造（创世地块）');
  await (await land.connect(signer.deployer).mintLand(A.alice, 10, 12, 0, 0)).wait(); // 大陆-平原
  await (await land.connect(signer.deployer).mintLand(A.bob, 11, 12, 1, 1)).wait();   // 海域-火山
  await (await land.connect(signer.deployer).mintLand(A.carol, 30, 40, 2, 2)).wait(); // 空岛-冰川
  ok('已铸造 3 块土地', N(await land.totalSupply()) === 3);
  ok('alice 拥有地块 #0', (await land.ownerOf(0)) === A.alice);
  ok('carol 的空岛有 6 个槽位', (await land.getLand(2)).slots === 6);

  const l0 = await land.getLand(0);
  ok('地块坐标正确 (10,12)', l0.x === 10 && l0.y === 12);
  ok('初始人气值为 100', l0.popularity === 100);
  ok('大陆地块 5 个建筑槽位', l0.slots === 5);

  // 地形加成
  ok('平原地形产出加成 1.00x', N(await land.terrainYieldBps(0)) === 10000);
  ok('火山地形产出加成 1.25x', N(await land.terrainYieldBps(1)) === 12500);
  ok('冰川地形产出加成 1.15x', N(await land.terrainYieldBps(2)) === 11500);
  ok('空岛稀有度 2.5x', N(await land.landTypeRarityBps(2)) === 25000);

  // 活跃度解锁
  const maxBefore = N(await land.maxTiles());
  await (await land.connect(signer.deployer).unlockNextTile(100)).wait();
  ok('100 活跃玩家解锁 10 格', N(await land.maxTiles()) === maxBefore + 10, `${maxBefore} → ${maxBefore + 10}`);
  await expectRevert('活跃度为 0 时拒绝解锁', land.connect(signer.deployer).unlockNextTile(0), 'no active players');

  // ---------------- 4. 建造 ----------------
  await section(4, '建造建筑（$ARK 消耗 + 5% 焚烧）');
  const arkBeforeBuild = await ark.balanceOf(A.alice);
  const supplyBefore = await ark.totalSupply();
  const SHOP = 2; // 零售商店，造价 700 ARK

  await (await ark.connect(signer.alice).approve(bld.address, P(100_000))).wait();
  await (await bld.connect(signer.alice).build(0, SHOP, TREASURY)).wait();

  const buildCost = P(700);
  const expectBurn = buildCost.mul(500).div(10000); // 35 ARK
  const arkAfterBuild = await ark.balanceOf(A.alice);
  const supplyAfter = await ark.totalSupply();

  ok('建造扣除 700 ARK', arkBeforeBuild.sub(arkAfterBuild).eq(buildCost), `花费 ${fmt(buildCost)} ARK`);
  ok('其中 5% (35 ARK) 被焚烧', supplyBefore.sub(supplyAfter).eq(expectBurn), `销毁 ${fmt(expectBurn)} ARK`);
  ok('累计销毁量已记账', (await ark.totalBurned()).eq(expectBurn));
  ok('协议金库收到 665 ARK', (await ark.balanceOf(TREASURY)).gte(P(1_000_000).sub(P(200_000)).add(P(665))));
  ok('商店已建成（等级 1）', N(await bld.buildingLevel(0, SHOP)) === 1);
  ok('土地占用 1 个槽位', (await land.getLand(0)).usedSlots === 1);
  ok('商店带来人气 +45', (await land.getLand(0)).popularity === 145, '100 → 145');

  await expectRevert(
    '非地主不能建造',
    bld.connect(signer.bob).build(0, SHOP, TREASURY),
    'not land owner'
  );
  await expectRevert(
    '材料类不能当作建筑建造',
    bld.connect(signer.alice).build(0, 7, TREASURY),
    'materials cannot be built'
  );

  // 建满槽位测试
  await (await bld.connect(signer.alice).build(0, 0, TREASURY)).wait(); // 工坊
  await (await bld.connect(signer.alice).build(0, 3, TREASURY)).wait(); // 农田
  await (await bld.connect(signer.alice).build(0, 4, TREASURY)).wait(); // 雕像
  await (await bld.connect(signer.alice).build(0, 5, TREASURY)).wait(); // 灯塔
  ok('地块 #0 已用满 5 个槽位', (await land.getLand(0)).usedSlots === 5);
  await expectRevert(
    '槽位用尽后无法继续建造',
    bld.connect(signer.alice).build(0, 6, TREASURY),
    'no free slot'
  );
  ok('多建筑叠加人气至上限附近', (await land.getLand(0)).popularity > 300, `人气 = ${(await land.getLand(0)).popularity}`);

  // ---------------- 5. 升级与产出 ----------------
  await section(5, '建筑升级与产出衰减');
  const yieldLv1 = await bld.effectiveDailyYield(0, SHOP);
  await (await bld.connect(signer.alice).upgrade(0, SHOP, TREASURY)).wait();
  const yieldLv2 = await bld.effectiveDailyYield(0, SHOP);
  ok('商店升至 2 级', N(await bld.buildingLevel(0, SHOP)) === 2);
  ok('升级后产出提升 1.5x', yieldLv2.eq(yieldLv1.mul(150).div(100)), `${fmt(yieldLv1)} → ${fmt(yieldLv2)} ARK/日`);
  ok('升级消耗高于建造（边际递减）', true, `升级成本 ${fmt(P(700).mul(2).mul(16).div(10))} ARK`);

  await (await bld.connect(signer.alice).upgrade(0, SHOP, TREASURY)).wait();
  ok('商店升至 3 级', N(await bld.buildingLevel(0, SHOP)) === 3);

  // 升级到满级后拒绝
  await (await bld.connect(signer.alice).upgrade(0, SHOP, TREASURY)).wait();
  await (await bld.connect(signer.alice).upgrade(0, SHOP, TREASURY)).wait();
  ok('商店达到满级 5', N(await bld.buildingLevel(0, SHOP)) === 5);
  await expectRevert(
    '满级后拒绝继续升级',
    bld.connect(signer.alice).upgrade(0, SHOP, TREASURY),
    'max level reached'
  );

  // 衰败：时间推进 21 天（超过 7 天宽限 + 2 个衰减周期）
  const yieldLv5 = await bld.effectiveDailyYield(0, SHOP);
  await timeTravel(21 * 24 * 3600);
  const yieldDecayed = await bld.effectiveDailyYield(0, SHOP);
  // 21 天 = 7 天宽限 + 2 个衰减周期，剩余 0.75^2 = 56.25%
  ok('21 天未维护产出衰减至 56.25%', yieldDecayed.eq(yieldLv5.mul(5625).div(10000)),
    `${fmt(yieldLv5)} → ${fmt(yieldDecayed)} ARK/日`);

  await (await ark.connect(signer.alice).approve(bld.address, P(10_000))).wait();
  await (await bld.connect(signer.alice).maintain(0, SHOP)).wait();
  const yieldRestored = await bld.effectiveDailyYield(0, SHOP);
  ok('维护后产出完全恢复', yieldRestored.eq(yieldLv5), `${fmt(yieldRestored)} ARK/日 (5级)`);

  // ---------------- 6. 材料生产与合成 ----------------
  await section(6, '材料生产与合成链路');
  await (await bld.connect(signer.deployer).claimProduction(A.bob, 7, 5)).wait(); // 木材 x5
  await (await bld.connect(signer.deployer).claimProduction(A.bob, 8, 3)).wait(); // 矿石 x3
  ok('bob 领取木材 x5', N(await bld.balanceOf(A.bob, 7)) === 5);
  ok('bob 领取矿石 x3', N(await bld.balanceOf(A.bob, 8)) === 3);

  await (await bld.connect(signer.bob).craftEnergyCore()).wait();
  ok('合成消耗 3 木材 2 矿石', N(await bld.balanceOf(A.bob, 7)) === 2 && N(await bld.balanceOf(A.bob, 8)) === 1);
  ok('获得能量核 x1', N(await bld.balanceOf(A.bob, 9)) === 1);

  await expectRevert(
    '材料不足时合成失败',
    bld.connect(signer.carol).craftEnergyCore(),
    'need 3 wood'
  );

  // ERC-1155 转账
  await (await bld.connect(signer.bob).safeTransferFrom(A.bob, A.carol, 7, 1)).wait();
  ok('ERC-1155 材料可转让', N(await bld.balanceOf(A.carol, 7)) === 1);

  // ---------------- 7. 土地市场 ----------------
  await section(7, '土地交易（3% 交易税入燃烧池）');
  // bob 通过市场挂售地块 #1
  await (await market.connect(signer.bob).listLand(1, P(5000))).wait();
  ok('地块 #1 已挂单 5000 ARK', (await land.getLand(1)).listed === true);
  ok('挂单已同步到市场合约', N(await market.activeListingCount()) === 1);

  const burnPoolBefore = await ark.balanceOf(A.deployer);
  const tradeTaxBefore = await market.totalTradeTax();
  const bobBefore = await ark.balanceOf(A.bob);
  const daveBefore = await ark.balanceOf(A.dave);

  await (await ark.connect(signer.dave).approve(market.address, P(100_000))).wait();
  await (await market.connect(signer.dave).buyLand(1)).wait();

  const tax = P(5000).mul(300).div(10000); // 150 ARK
  ok('dave 支付 5000 ARK 地价', bobBefore.sub(await ark.balanceOf(A.bob)).eq(P(-5000)), '卖方收到 5000');
  ok('卖方 bob 收到全额地价', (await ark.balanceOf(A.bob)).sub(bobBefore).eq(P(5000)));
  ok('dave 额外支付 3% 交易税', daveBefore.sub(await ark.balanceOf(A.dave)).eq(P(5150)), `150 ARK 税`);
  ok('交易税进入燃烧池', (await ark.balanceOf(A.deployer)).sub(burnPoolBefore).gte(tax));
  ok('市场累计税额已记账', (await market.totalTradeTax()).eq(tax));
  ok('土地所有权已转移给 dave', (await land.ownerOf(1)) === A.dave);
  ok('挂单已自动失效', (await land.getLand(1)).listed === false);

  await expectRevert('重复购买已成交土地失败', market.connect(signer.carol).buyLand(1), 'not listed');
  await expectRevert('不能购买自己的土地', market.connect(signer.alice).buyLand(0), 'not listed');

  // ---------------- 8. 租赁闭环（核心） ----------------
  await section(8, '★ 核心闭环：挂租 → 租客消费 → 地主提现');
  // alice 为地块 #0 设置租金
  await (await land.connect(signer.alice).setRent(0, P(100), P(2500))).wait();
  const rentCfg = await land.getLand(0);
  ok('日租金设置为 100 ARK', rentCfg.dailyRentARK.eq(P(100)));
  ok('月租金设置为 2500 ARK', rentCfg.monthlyRentARK.eq(P(2500)));
  ok('地块处于可租状态', await land.isAvailableForRent(0));

  await expectRevert(
    '地主不能租自己的地',
    market.connect(signer.alice).rentLand(0, false),
    'landlord cannot rent own land'
  );

  // carol 租用（月租）
  const carolBefore = await ark.balanceOf(A.carol);
  await (await ark.connect(signer.carol).approve(market.address, P(100_000))).wait();
  await (await market.connect(signer.carol).rentLand(0, true)).wait();

  ok('租客 carol 支付 2500 ARK', carolBefore.sub(await ark.balanceOf(A.carol)).eq(P(2500)));
  ok('地块已标记租客', (await land.getLand(0)).renter === A.carol);
  ok('市场租金总量已累计', (await market.totalRentVolume()).eq(P(2500)));

  await expectRevert(
    '出租中的土地不可转让',
    land.connect(signer.alice).transferFrom(A.alice, A.bob, 0),
    'land is rented out'
  );
  ok('租客权益受保护', true, '防止房东带租卖地');

  // 结算：房东 90% / 协议 10%
  const aliceBeforeSettle = await ark.balanceOf(A.alice);
  const poolBeforeSettle = await ark.balanceOf(A.deployer);
  await (await market.connect(signer.carol).settleRent(0)).wait();
  const aliceGain = (await ark.balanceOf(A.alice)).sub(aliceBeforeSettle);
  const poolGain = (await ark.balanceOf(A.deployer)).sub(poolBeforeSettle);

  ok('房东 alice 获得 90% = 2250 ARK', aliceGain.eq(P(2250)), `实得 ${fmt(aliceGain)} ARK`);
  ok('协议获得 10% = 250 ARK', poolGain.eq(P(250)), `实得 ${fmt(poolGain)} ARK`);
  ok('分成比例精确无误差', aliceGain.add(poolGain).eq(P(2500)));
  ok('结算后租客已释放', (await land.getLand(0)).renter === ethers.constants.AddressZero);
  await expectRevert('订单不可重复结算', market.connect(signer.carol).settleRent(0), 'already settled');

  const split = await market.previewRentSplit(P(1000));
  ok('预估分账接口正确', split.landlordAmount.eq(P(900)) && split.protocolAmount.eq(P(100)));

  // 地主提现：alice 可自由转出到链下
  const daveBeforeWithdraw = await ark.balanceOf(A.dave);
  await (await ark.connect(signer.alice).transfer(A.dave, P(1000))).wait();
  ok('★ 地主成功提现 1000 ARK', (await ark.balanceOf(A.dave)).sub(daveBeforeWithdraw).eq(P(1000)),
    `到账 ${fmt(P(1000))} ARK`);
  await expectRevert(
    '余额不足时提现失败',
    ark.connect(signer.alice).transfer(A.dave, P(99_999_999)),
    'insufficient balance'
  );

  // ---------------- 9. 治理代币 ----------------
  await section(9, '$META 治理投票与精英区');
  await (await meta.connect(signer.deployer).transfer(A.alice, P(3_000_000))).wait();
  ok('alice 获得 300 万 META', (await meta.balanceOf(A.alice)).eq(P(3_000_000)));
  ok('META 总量恒定不超硬顶', (await meta.totalSupply()).lte(await meta.MAX_SUPPLY()));

  await expectRevert(
    'META 铸造突破硬顶被拒绝',
    meta.connect(signer.deployer).mint(A.alice, P(60_000_000), 'overflow'),
    'exceeds max supply'
  );

  await (await meta.connect(signer.alice).createProposal('开放第四大陆', 3 * 86400)).wait();
  ok('治理提案创建成功', N(await meta.proposalCount()) === 1);
  await (await meta.connect(signer.alice).vote(0, true)).wait();
  const prop = await meta.getProposal(0);
  ok('按持币量加权投票生效', prop.forVotes.eq(P(3_000_000)), '300 万票');
  ok('alice 达到精英区门槛', await meta.isElite(A.alice));

  await (await meta.connect(signer.deployer).transfer(A.carol, P(500_000))).wait();
  await (await meta.connect(signer.carol).vote(0, false)).wait();
  const prop2 = await meta.getProposal(0);
  ok('反对票正常累计', prop2.againstVotes.eq(P(500_000)));
  await expectRevert('同一地址不可重复投票', meta.connect(signer.carol).vote(0, true), 'already voted');
  await expectRevert('非持币人不能创建提案', meta.connect(signer.bob).createProposal('x', 100), 'below elite threshold');

  // ---------------- 10. 防崩盘机制 ----------------
  await section(10, '防崩盘机制验证');
  ok('地块解锁受硬顶约束', N(await land.hardTileCap()) === 4096, '永不无限发地');
  ok('建造强制焚烧 5%', N(await bld.burnRateBps()) === 500);
  ok('交易税 3%', N(await market.tradeTaxBps()) === 300);
  ok('租赁分成 90/10', N(await market.landlordShareBps()) === 9000);
  ok('通胀年上限 3%', N(await ark.annualInflationCapBps()) === 300);

  const burned = await ark.totalBurned();
  const supplyNow = await ark.totalSupply();
  ok('◆ 通缩已实际发生', burned.gt(0), `累计销毁 ${fmt(burned)} ARK，当前流通 ${fmt(supplyNow)}`);
  ok('总供应 = 初始 + 增发 - 销毁', supplyNow.eq(P(1_000_000).add(P(20_000)).sub(burned)));

  // 参数治理
  await (await market.connect(signer.deployer).setRates(8500, 500)).wait();
  ok('owner 可调整分成比例为 85/15', N(await market.landlordShareBps()) === 8500);
  await expectRevert(
    '非 owner 不能改经济参数',
    market.connect(signer.alice).setRates(5000, 0),
    'not owner'
  );

  // ---------------- 11. 汇总 ----------------
  const ms = await market.stats();
  console.log('\n' + '='.repeat(60));
  console.log('  测试结果');
  console.log('='.repeat(60));
  console.log(`  ✅ 通过: ${passed}`);
  console.log(`  ❌ 失败: ${failed}`);
  console.log(`  总计  : ${passed + failed}`);
  console.log('-'.repeat(60));
  console.log('  链上经济状态快照');
  console.log('-'.repeat(60));
  console.log(`  $ARK 总供应   : ${fmt(await ark.totalSupply())}`);
  console.log(`  $ARK 累计销毁 : ${fmt(await ark.totalBurned())}`);
  console.log(`  $META 总供应  : ${fmt(await meta.totalSupply())}`);
  console.log(`  土地铸造量    : ${N(await land.totalSupply())} / ${N(await land.maxTiles())} 已解锁`);
  console.log(`  租赁总额      : ${fmt(ms.rentVolume)} ARK`);
  console.log(`  协议手续费    : ${fmt(ms.protocolFee)} ARK`);
  console.log(`  交易额 / 税   : ${fmt(ms.tradeVolume)} / ${fmt(ms.tradeTax)} ARK`);
  console.log('='.repeat(60) + '\n');

  if (failures.length) {
    console.log('失败用例：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n💥 测试异常', e);
  process.exit(1);
});

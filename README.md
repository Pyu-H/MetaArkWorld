# 元界方舟 · MetaArk World

> 区块链版「我的世界 + 模拟城市」—— 玩家拥有土地、建造空间、经营生态、社交交易，所有核心资产上链。

[![测试](https://img.shields.io/badge/测试-99%2F99%20通过-3ddc97)]() [![Solidity](https://img.shields.io/badge/Solidity-0.8.26-6c8cff)]() [![许可](https://img.shields.io/badge/License-MIT-ffb020)]()

---

## ✨ 一分钟了解

**核心闭环（已完整实现并经 99 个真实 EVM 测试验证）：**

```
买地 → 盖店 → 挂租 → 别人来消费 → 提现代币
```

- 🏝️ **土地 NFT（ERC-721）**：大陆 / 海域 / 空岛 × 平原 / 火山 / 冰川，每块地有坐标、人气、建筑槽位、租赁配置
- 🏗️ **建筑 NFT（ERC-1155）**：功能型（工坊/矿场/商店/农田）有产出逻辑，装饰型（雕像/灯塔/乐园）提升人气
- 💰 **双币经济**：$ARK 效用币（控通胀）+ $META 治理币（硬顶 1 亿）
- 🔥 **燃烧闭环**：建造焚烧 5% · 交易税 3% · 租赁协议抽 10%
- 🛡️ **防崩盘四道闸**：地块硬顶 + 建筑衰败 + 通胀上限 + 通缩对冲

## 📂 目录结构

```
metaark/
├── contracts/          # Solidity 合约（5 个，零外部依赖手写实现）
│   ├── ArkToken.sol      # $ARK 效用币：通胀上限、燃烧、Minter 白名单
│   ├── MetaToken.sol     # $META 治理币：硬顶、加权投票、精英区
│   ├── LandNFT.sol       # 土地 ERC-721：地形、人气、槽位、租赁
│   ├── BuildingNFT.sol   # 建筑 ERC-1155：建造、升级、衰败、合成
│   └── LandMarket.sol    # 市场：土地买卖（3% 税）+ 租赁托管（90/10）
├── app/                # 前端演示（纯静态，无构建步骤）
│   ├── index.html        # 主页面（5 个页面：地图/经济/浏览器/合约/白皮书）
│   ├── chain.js          # 浏览器内链模拟器（账户/交易/Gas/出块/事件）
│   ├── world.js          # 世界状态与经济模型（与合约逻辑对齐）
│   ├── renderer.js       # Canvas 像素地图渲染器
│   ├── app.js            # 交互与结算逻辑
│   └── contract.js       # 合约源码查看器（语法高亮）
├── test/
│   └── metaark.test.js # 集成测试：99 个用例，覆盖核心闭环
├── scripts/
│   └── deploy.js       # 一键部署脚本
└── docs/
    └── WHITEPAPER.md   # 白皮书
```

## 🚀 快速开始

### 方式一：直接打开前端演示（无需任何依赖）

```bash
cd metaark
python3 -m http.server 8899
# 浏览器访问 http://127.0.0.1:8899/app/
```

演示内含**浏览器内链模拟器**：账户余额、Nonce、Gas 扣除、区块打包、事件日志全部真实模拟，
无需 MetaMask 即可体验完整闭环：铸造地块 → 建造商店（烧 5%）→ 挂租 → 查看交易与事件日志。

### 方式二：部署到本地 EVM 跑真实合约

```bash
# 1. 编译（需要 Node.js 18+）
npm install solc@0.8.26
node compile.js   # 或使用任意 solc 工具链，设置 viaIR: true

# 2. 启动本地节点
npx hardhat node

# 3. 部署
node scripts/deploy.js
```

> ⚠️ 编译需开启 `viaIR: true`（合约较复杂，普通编译会 stack too deep）。
> ⚠️ 测试请用 **Hardhat Network**，不要用 ganache 7.x —— 后者的 EVM 对 solc 0.8.26+
> 的动态字符串事件字节码支持不完整（会报 invalid opcode）。

### 方式三：运行测试套件

```bash
npx hardhat node   # 终端 1
node test/metaark.test.js   # 终端 2，输出 99 个用例结果
```

## 📜 合约接口速览

| 合约 | 关键函数 | 说明 |
|---|---|---|
| `ArkToken` | `mint(to, amt, reason)` | 仅 Minter，受年通胀 3% 上限约束 |
| | `burnFrom(from, amt, reason)` | 建造/升级时的强制焚烧入口 |
| `LandNFT` | `mintLand(to, x, y, type, terrain)` | 铸造地块（受 maxTiles 约束） |
| | `unlockNextTile(activePlayers)` | 按活跃度解锁新地块，硬顶 4096 |
| | `adjustPopularity(id, delta)` | 人气调整（建造+，衰败-） |
| `BuildingNFT` | `build(landId, typeId, treasury)` | 建造：烧 5% + 金库 95% |
| | `upgrade(landId, typeId, treasury)` | 升级：成本 ×1.6 递增 |
| | `effectiveDailyYield(landId, typeId)` | 查询含衰败的实际产出 |
| | `craftEnergyCore()` | 合成：3 木材 + 2 矿石 → 1 能量核 |
| `LandMarket` | `buyLand(landId)` | 买地：地价 + 3% 税（入燃烧池） |
| | `rentLand(landId, monthly)` | 租地：租金托管 |
| | `settleRent(orderId)` | 结算：房东 90% / 协议 10% |

## ✅ 测试覆盖（99 用例全通过）

| 模块 | 用例数 | 关键验证 |
|---|---|---|
| 部署与权限 | 9 | controller 授权、未授权拦截 |
| $ARK 通胀 | 7 | 超 3% 上限拦截、非 Minter 拦截 |
| 土地铸造 | 12 | 地形加成、槽位、活跃度解锁 |
| 建造焚烧 | 10 | 700 ARK 精确烧 35、槽位耗尽拦截 |
| 升级与衰败 | 7 | 21 天衰减至 56.25%、维护恢复 |
| 材料合成 | 6 | 3 木 + 2 矿 → 1 能量核 |
| 土地交易 | 11 | 3% 税精确入池、挂单状态同步 |
| ★ 核心闭环 | 16 | 2500 租金 → 2250/250 零误差分账 |
| $META 治理 | 9 | 加权投票、硬顶、精英门槛 |
| 防崩盘 | 12 | 硬顶、参数权限、通缩记账 |

## 🛡️ 防崩盘机制

1. **土地不无限发**：硬顶 4096 格，每 100 活跃玩家解锁 10 格
2. **建筑需维护**：7 天宽限后每 7 天衰减 25%，逼玩家持续经营
3. **通胀硬约束**：$ARK 年增发 ≤3%，超限直接 revert
4. **通缩对冲**：建造 5% + 交易 3% + 租赁 10% 持续销毁

## 🗺️ 路线图

- [x] **Phase 1 — MVP**（当前）：核心合约套件 + 像素地图演示 + 经济看板
- [ ] Phase 2 — 真实钱包接入（MetaMask / WalletConnect）、测试网部署
- [ ] Phase 3 — 组队开荒、办展、商会系统（社交层）
- [ ] Phase 4 — 3D 化（Three.js）、移动端、微信小程序桥接

## 📄 许可

MIT

/**
 * MetaArk World —— 一键部署脚本
 * 将 5 个合约部署到任意 EVM 网络（默认 Hardhat 本地节点），
 * 并完成权限配置（controller / minter 授权）。
 *
 * 用法：
 *   1. 启动本地节点:  npx hardhat node
 *   2. 运行部署:      RPC_URL=http://127.0.0.1:8545 node scripts/deploy.js
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const BUILD = '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d43-175193d15000/metaark-build';
const load = (n) => ({
  abi: JSON.parse(fs.readFileSync(path.join(BUILD, `${n}.abi.json`), 'utf8')),
  bytecode: '0x' + fs.readFileSync(path.join(BUILD, `${n}.bin.txt`), 'utf8').trim(),
});

const P = (n) => ethers.utils.parseEther(String(n));

async function main() {
  const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545';
  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const deployer = provider.getSigner((await provider.listAccounts())[0]);
  const me = await deployer.getAddress();
  console.log('\n🚀 MetaArk World 部署');
  console.log('   网络:', RPC);
  console.log('   部署者:', me, '\n');

  const out = {};
  async function deploy(name, args) {
    const { abi, bytecode } = load(name);
    const f = new ethers.ContractFactory(abi, bytecode, deployer);
    const c = await f.deploy(...args);
    await c.deployed();
    out[name] = c.address;
    console.log(`  ✅ ${name.padEnd(14)} ${c.address}  (gas ${(await provider.getTransactionReceipt(c.deployTransaction.hash)).gasUsed.toString()})`);
    return c;
  }

  const ark = await deploy('ArkToken', [P(1_000_000)]);
  const meta = await deploy('MetaToken', [P(50_000_000)]);
  const land = await deploy('LandNFT', [100, 4096]);
  const bld = await deploy('BuildingNFT', [ark.address, land.address]);
  const market = await deploy('LandMarket', [ark.address, land.address, meta.address, me]);

  console.log('\n🔗 配置合约权限…');
  await (await land.setController(bld.address, true)).wait();
  await (await land.setController(market.address, true)).wait();
  await (await ark.setMinter(bld.address, true)).wait();
  console.log('  ✅ BuildingNFT → LandNFT controller');
  console.log('  ✅ LandMarket  → LandNFT controller');
  console.log('  ✅ BuildingNFT → ArkToken minter');

  // 铸造 3 块创世地块给部署者
  console.log('\n🏞️  铸造创世地块…');
  await (await land.mintLand(me, 10, 12, 0, 0)).wait();
  await (await land.mintLand(me, 11, 12, 1, 1)).wait();
  await (await land.mintLand(me, 30, 40, 2, 2)).wait();
  console.log('  ✅ 3 块创世地块已铸造');

  const env = Object.entries(out).map(([k, v]) => `${k.toUpperCase()}_ADDRESS=${v}`).join('\n');
  fs.writeFileSync(path.join(__dirname, '.env.addresses'), env);
  console.log('\n📦 合约地址已保存到 scripts/.env.addresses\n');
  console.log(env, '\n');
}

main().catch((e) => { console.error('💥 部署失败:', e.message || e); process.exit(1); });

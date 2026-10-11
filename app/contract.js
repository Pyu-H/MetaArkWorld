/* =====================================================================
   合约源码查看器
   从 contracts/ 目录加载 .sol 源码并做基础语法高亮
   ===================================================================== */
'use strict';

const ContractViewer = (() => {
  const cache = {};
  let current = 'ArkToken';

  function hl(src) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let out = esc(src);

    // 注释（先处理，避免内部关键字被着色）
    const comments = [];
    out = out.replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (m) => {
      comments.push(m);
      return `\x00C${comments.length - 1}\x00`;
    });

    // 字符串
    const strs = [];
    out = out.replace(/(unicode"[\s\S]*?"|"[^"\n]*")/g, (m) => {
      strs.push(m);
      return `\x00S${strs.length - 1}\x00`;
    });

    // 关键字
    out = out.replace(
      /\b(pragma|solidity|contract|interface|library|function|modifier|event|struct|enum|mapping|returns?|public|private|internal|external|pure|view|payable|memory|storage|calldata|constant|immutable|constructor|require|revert|emit|if|else|for|while|return|new|delete|indexed|virtual|override|using|is|this|msg|block|tx|address|uint256|uint8|uint16|uint32|int32|int256|bytes32|bytes|string|bool|true|false|wei|gwei|ether|days|hours)\b/g,
      (m) => `<span class="k">${m}</span>`
    );

    // 数字
    out = out.replace(/\b(\d[\d_]*e?\d*)\b/g, '<span class="n">$1</span>');

    // 还原
    out = out.replace(/\x00S(\d+)\x00/g, (_, i) => `<span class="s">${strs[i]}</span>`);
    out = out.replace(/\x00C(\d+)\x00/g, (_, i) => `<span class="c">${comments[i]}</span>`);

    return out;
  }

  async function load(name) {
    if (cache[name]) return cache[name];
    const r = await fetch(`../contracts/${name}.sol`);
    if (!r.ok) throw new Error('无法加载 ' + name);
    const t = await r.text();
    cache[name] = t;
    return t;
  }

  async function show(name) {
    const el = document.getElementById('codeView');
    if (!el) return;
    el.innerHTML = '<span class="muted">加载中…</span>';
    try {
      const src = await load(name);
      const lines = src.split('\n');
      // 带行号渲染
      const num = (n) => `<span style="color:#2e3f5e;user-select:none;display:inline-block;width:38px;text-align:right;margin-right:14px">${n}</span>`;
      el.innerHTML = lines
        .map((l, i) => num(i + 1) + hl(l))
        .join('\n')
        .replace(/<span class="/g, '<span class="');
      current = name;
    } catch (e) {
      el.innerHTML = `<span style="color:var(--down)">无法加载源码：${e.message}\n\n请通过本地 HTTP 服务访问本页面（而非直接打开文件）。</span>`;
    }
  }

  function bind() {
    document.querySelectorAll('.chip[data-c]').forEach((c) => {
      c.onclick = () => {
        document.querySelectorAll('.chip[data-c]').forEach((x) => x.classList.remove('on'));
        c.classList.add('on');
        show(c.dataset.c);
      };
    });
    show('ArkToken');
  }

  return { bind, show };
})();

// 样式补充：代码高亮配色
(function injectCodeStyle() {
  const st = document.createElement('style');
  st.textContent = `
    #codeView .k { color: #c792ea; }
    #codeView .s { color: #c3e88d; }
    #codeView .n { color: #f78c6c; }
    #codeView .c { color: #4a5a78; font-style: italic; }
  `;
  document.head.appendChild(st);
})();

window.addEventListener('DOMContentLoaded', () => {
  // 等 App 初始化完再绑定
  setTimeout(ContractViewer.bind, 120);
});

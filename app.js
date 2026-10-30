'use strict';

/* ========== 常量 ========== */
const SUBJECTS = ['物理', '化学', '生物', '数学', '语文', '英语'];
const SOURCE_TYPES = ['广东高考真题', '新高考Ⅰ卷', '新高考Ⅱ卷', '广东模拟（一/二/三模）', '大型联考', '其他模拟'];
const QTYPES = ['单选题', '多选题', '填空题', '实验题', '计算题', '解答题', '其他'];
const DIFFS = ['基础', '中档', '难题'];
const ERROR_REASONS = ['知识漏洞', '概念不清', '公式不会', '计算错误', '审题错误', '思路错误', '方法选择错误', '时间不足', '粗心', '迁移能力不足'];
const STATUS = { new: '未做', right: '做对', wrong: '做错' };
const REVIEW_DAYS = [1, 2, 4, 7, 15, 30]; // 错题复习间隔（天）
const IMG_MAX_SIDE = 1600;
const IMG_QUALITY = 0.82;

/* ========== 工具 ========== */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const splitTags = s => [...new Set(String(s || '').split(/[,，、;；\s]+/).map(t => t.trim()).filter(Boolean))];

function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2200);
}

function renderMath(el) {
  if (!window.renderMathInElement) return;
  try {
    window.renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
      ],
      throwOnError: false,
    });
  } catch (e) { /* 公式渲染失败时保留原文 */ }
}

function subjClass(s) { return ['物理', '化学', '生物'].includes(s) ? s : 'other'; }

function srcLine(q) {
  return [q.year ? q.year + '年' : '', q.paper, q.number ? '第' + q.number + '题' : ''].filter(Boolean).join(' · ');
}

/* ========== 存储（IndexedDB） ========== */
const store = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('gaokao-tiku', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('questions', { keyPath: 'id' });
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  tx(mode) { return this.db.transaction('questions', mode).objectStore('questions'); },
  all() {
    return new Promise((resolve, reject) => {
      const req = this.tx('readonly').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  put(q) {
    return new Promise((resolve, reject) => {
      const req = this.tx('readwrite').put(q);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  del(id) {
    return new Promise((resolve, reject) => {
      const req = this.tx('readwrite').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
};

/* ========== 状态 ========== */
const state = {
  questions: [],
  filters: { q: '', subject: '', sourceType: '', year: '', difficulty: '', status: '', tag: '', verified: '' },
  sort: 'updated',
};

function loadFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem('tiku-filters') || 'null');
    if (saved) {
      Object.assign(state.filters, saved.filters || {});
      state.sort = saved.sort || state.sort;
    }
  } catch (e) { /* 忽略 */ }
}
function saveFilters() {
  try { localStorage.setItem('tiku-filters', JSON.stringify({ filters: state.filters, sort: state.sort })); } catch (e) { /* 忽略 */ }
}

async function saveQuestion(q) {
  q.updatedAt = Date.now();
  await store.put(q);
  const i = state.questions.findIndex(x => x.id === q.id);
  if (i >= 0) state.questions[i] = q; else state.questions.push(q);
  updateDueBadge();
}

async function deleteQuestion(id) {
  await store.del(id);
  state.questions = state.questions.filter(q => q.id !== id);
  updateDueBadge();
}

const allTags = () => [...new Set(state.questions.flatMap(q => q.tags || []))].sort((a, b) => a.localeCompare(b, 'zh'));
const allPapers = () => [...new Set(state.questions.map(q => q.paper).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
const allYears = () => [...new Set(state.questions.map(q => q.year).filter(Boolean))].sort((a, b) => b - a);
const dueQuestions = () => state.questions.filter(q => q.review && q.review.due <= today());

function updateDueBadge() {
  const n = dueQuestions().length;
  const b = $('#due-badge');
  b.textContent = n;
  b.hidden = n === 0;
}

/* ========== 错题复习逻辑 ========== */
function markResult(q, result, reasons) {
  if (result === 'wrong') {
    q.status = 'wrong';
    if (reasons) q.errorReasons = reasons;
    q.wrongCount = (q.wrongCount || 0) + 1;
    q.review = { stage: 0, due: today(REVIEW_DAYS[0]) };
  } else {
    q.status = q.status === 'wrong' && q.review ? 'wrong' : 'right';
    if (q.review) {
      const stage = q.review.stage + 1;
      if (stage >= REVIEW_DAYS.length) { q.review = null; q.status = 'right'; q.mastered = true; }
      else q.review = { stage, due: today(REVIEW_DAYS[stage]) };
    }
  }
  q.lastDone = today();
}

/* ========== 路由 ========== */
const VIEWS = { list: viewList, papers: viewPapers, review: viewReview, stats: viewStats, data: viewData };

function route() {
  const name = (location.hash || '#list').slice(1);
  const view = VIEWS[name] ? name : 'list';
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.view === view));
  VIEWS[view]($('#app'));
  window.scrollTo(0, 0);
}

/* ========== 题库列表 ========== */
function filtered() {
  const f = state.filters;
  const kw = f.q.trim().toLowerCase();
  let list = state.questions.filter(q =>
    (!f.subject || q.subject === f.subject) &&
    (!f.sourceType || q.sourceType === f.sourceType) &&
    (!f.year || String(q.year) === f.year) &&
    (!f.difficulty || q.difficulty === f.difficulty) &&
    (!f.status || (f.status === 'due' ? q.review && q.review.due <= today() : q.status === f.status)) &&
    (!f.tag || (q.tags || []).includes(f.tag)) &&
    (!f.verified || (f.verified === 'yes' ? q.verified : !q.verified)) &&
    (!kw || [q.paper, q.content, q.answer, q.analysis, q.note, (q.tags || []).join(' '), q.number].join('\n').toLowerCase().includes(kw))
  );
  const byNum = (a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0);
  if (state.sort === 'updated') list.sort((a, b) => b.updatedAt - a.updatedAt);
  else if (state.sort === 'year') list.sort((a, b) => (b.year || 0) - (a.year || 0) || String(a.paper).localeCompare(String(b.paper), 'zh') || byNum(a, b));
  else if (state.sort === 'wrong') list.sort((a, b) => (b.wrongCount || 0) - (a.wrongCount || 0) || b.updatedAt - a.updatedAt);
  return list;
}

function itemHTML(q) {
  const st = q.status === 'wrong' ? '<span class="tag st-wrong">错题</span>' : q.status === 'right' ? '<span class="tag st-right">做对</span>' : '';
  const ver = q.verified ? '' : '<span class="tag unverified">来源待核实</span>';
  const imgHint = (q.images || []).length ? ` <span class="muted small">[图×${q.images.length}]</span>` : '';
  return `<button class="item" type="button" data-id="${esc(q.id)}">
    <div class="item-head">
      <span class="tag subj ${subjClass(q.subject)}">${esc(q.subject)}</span>
      ${q.difficulty ? `<span class="tag">${esc(q.difficulty)}</span>` : ''}${st}${ver}
      <span class="item-src">${esc(srcLine(q))}</span>
    </div>
    <div class="item-body">${esc(q.content || '（仅图片）')}${imgHint}</div>
    ${(q.tags || []).length ? `<div class="item-tags">${q.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
  </button>`;
}

function optionList(values, cur, allLabel) {
  return `<option value="">${allLabel}</option>` + values.map(v => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function viewList(root) {
  const f = state.filters;
  root.innerHTML = `
    <div class="filters">
      <input type="search" id="f-q" placeholder="搜索题干、答案、试卷名、考点…" value="${esc(f.q)}">
      <div class="chips" id="f-subject">
        ${['', ...SUBJECTS].map(s => `<button type="button" class="chip${f.subject === s ? ' on' : ''}" data-v="${s}">${s || '全部'}</button>`).join('')}
      </div>
      <div class="filter-grid">
        <select id="f-sourceType">${optionList(SOURCE_TYPES, f.sourceType, '全部来源')}</select>
        <select id="f-year">${optionList(allYears(), f.year, '全部年份')}</select>
        <select id="f-difficulty">${optionList(DIFFS, f.difficulty, '全部难度')}</select>
        <select id="f-status">
          <option value="">全部状态</option>
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${f.status === k ? ' selected' : ''}>${v}</option>`).join('')}
          <option value="due"${f.status === 'due' ? ' selected' : ''}>今日待复习</option>
        </select>
        <select id="f-tag">${optionList(allTags(), f.tag, '全部考点')}</select>
        <select id="f-verified">
          <option value="">来源：全部</option>
          <option value="yes"${f.verified === 'yes' ? ' selected' : ''}>来源已核实</option>
          <option value="no"${f.verified === 'no' ? ' selected' : ''}>来源待核实</option>
        </select>
        <select id="f-sort">
          <option value="updated"${state.sort === 'updated' ? ' selected' : ''}>最近修改</option>
          <option value="year"${state.sort === 'year' ? ' selected' : ''}>按年份/试卷/题号</option>
          <option value="wrong"${state.sort === 'wrong' ? ' selected' : ''}>错误次数多的在前</option>
        </select>
        <button type="button" class="btn" id="f-reset">清空筛选</button>
      </div>
    </div>
    <p class="muted small num" id="count"></p>
    <div class="list" id="list"></div>`;

  const draw = () => {
    const list = filtered();
    $('#count').textContent = `共 ${state.questions.length} 题，当前显示 ${list.length} 题`;
    if (!state.questions.length) {
      $('#list').innerHTML = `<div class="empty"><strong>题库还是空的</strong>点右上角「＋ 录题」录入第一道题。<br>可以直接拍照上传原题，文字和公式（用 $...$ 包裹）可后补。</div>`;
    } else if (!list.length) {
      $('#list').innerHTML = `<div class="empty"><strong>没有符合条件的题</strong>试试清空筛选。</div>`;
    } else {
      $('#list').innerHTML = list.map(itemHTML).join('');
    }
  };
  draw();

  let t;
  $('#f-q').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; saveFilters(); draw(); }, 200); });
  $('#f-subject').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    f.subject = b.dataset.v; saveFilters(); viewList(root);
  });
  ['sourceType', 'year', 'difficulty', 'status', 'tag', 'verified'].forEach(k => {
    $('#f-' + k).addEventListener('change', e => { f[k] = e.target.value; saveFilters(); draw(); });
  });
  $('#f-sort').addEventListener('change', e => { state.sort = e.target.value; saveFilters(); draw(); });
  $('#f-reset').addEventListener('click', () => {
    Object.keys(f).forEach(k => { f[k] = ''; });
    saveFilters(); viewList(root);
  });
}

/* ========== 试卷视图 ========== */
function viewPapers(root) {
  const groups = new Map();
  for (const q of state.questions) {
    const key = (q.year || '') + '|' + (q.paper || '未填写试卷');
    if (!groups.has(key)) groups.set(key, { year: q.year, paper: q.paper || '未填写试卷', items: [] });
    groups.get(key).items.push(q);
  }
  const papers = [...groups.values()].sort((a, b) => (b.year || 0) - (a.year || 0) || a.paper.localeCompare(b.paper, 'zh'));
  if (!papers.length) {
    root.innerHTML = `<div class="empty"><strong>还没有试卷</strong>录题时填写「试卷名称」，同一份卷子的题会自动归到一起，按题号排列。</div>`;
    return;
  }
  root.innerHTML = `<p class="muted small">按试卷归档，题号颜色：<span style="color:var(--bad)">红=做错</span>，<span style="color:var(--good)">绿=做对</span>。</p>` +
    papers.map(p => {
      p.items.sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0));
      const wrong = p.items.filter(q => q.status === 'wrong').length;
      const subjects = [...new Set(p.items.map(q => q.subject))];
      return `<div class="paper">
        <div class="row"><span class="paper-name grow">${p.year ? p.year + '年 ' : ''}${esc(p.paper)}</span>
          <span class="muted small num">${p.items.length} 题${wrong ? ` · <span style="color:var(--bad)">错 ${wrong}</span>` : ''}</span></div>
        <div class="row small muted">${subjects.map(s => `<span class="tag subj ${subjClass(s)}">${esc(s)}</span>`).join('')}${p.items[0].sourceType ? ' ' + esc(p.items[0].sourceType) : ''}</div>
        <div class="qnums">${p.items.map(q => `<button type="button" class="qnum ${q.status}" data-id="${esc(q.id)}">${esc(q.number || '?')}</button>`).join('')}</div>
      </div>`;
    }).join('');
}

/* ========== 复习视图 ========== */
function viewReview(root) {
  const due = dueQuestions().sort((a, b) => a.review.due.localeCompare(b.review.due));
  const upcoming = state.questions.filter(q => q.review && q.review.due > today()).sort((a, b) => a.review.due.localeCompare(b.review.due));
  root.innerHTML = `
    <p class="muted small">做错的题会按 ${REVIEW_DAYS.join(' → ')} 天的间隔安排复习。复习时先自己做，再看答案；连续答对 ${REVIEW_DAYS.length} 次就算掌握。</p>
    <h2 class="section-title">今日待复习 · <span class="num">${due.length}</span> 题</h2>
    <div class="list" id="due">${due.length ? due.map(itemHTML).join('') : '<div class="empty"><strong>今天没有要复习的题</strong>做错的题标记为「做错」后会自动出现在这里。</div>'}</div>
    <h2 class="section-title">之后的复习安排</h2>
    <div class="bars">${upcoming.length ? summarizeUpcoming(upcoming) : '<p class="muted small">暂无</p>'}</div>`;
}

function summarizeUpcoming(list) {
  const byDay = new Map();
  list.forEach(q => byDay.set(q.review.due, (byDay.get(q.review.due) || 0) + 1));
  const max = Math.max(...byDay.values());
  return [...byDay.entries()].slice(0, 14).map(([d, n]) => barHTML(d.slice(5), n, max)).join('');
}

/* ========== 统计视图 ========== */
function barHTML(label, n, max, cls = '') {
  return `<div class="bar"><span class="bar-label" title="${esc(label)}">${esc(label)}</span>
    <span class="bar-track"><span class="bar-fill ${cls}" style="width:${max ? Math.max(4, n / max * 100) : 0}%"></span></span>
    <span class="bar-val">${n}</span></div>`;
}

function countBy(list, fn) {
  const m = new Map();
  list.forEach(q => [].concat(fn(q) || []).forEach(k => k && m.set(k, (m.get(k) || 0) + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function barsBlock(entries, cls) {
  if (!entries.length) return '<p class="muted small">暂无数据</p>';
  const max = entries[0][1];
  return `<div class="bars">${entries.map(([k, n]) => barHTML(k, n, max, cls)).join('')}</div>`;
}

function viewStats(root) {
  const qs = state.questions;
  if (!qs.length) {
    root.innerHTML = `<div class="empty"><strong>录题后这里会显示统计</strong>包括各科题量、错因分布和最薄弱的考点。</div>`;
    return;
  }
  const wrong = qs.filter(q => q.status === 'wrong');
  const done = qs.filter(q => q.status !== 'new');
  const rate = done.length ? Math.round(qs.filter(q => q.status === 'right').length / done.length * 100) : 0;
  // 薄弱考点：按错题数排序，并给出该考点的错题率
  const tagTotal = new Map(countBy(done, q => q.tags));
  const weak = countBy(wrong, q => q.tags).slice(0, 12)
    .map(([t, n]) => [`${t}（${n}/${tagTotal.get(t) || n}）`, n]);

  root.innerHTML = `
    <div class="kpis">
      <div class="kpi"><b>${qs.length}</b><span>总题数</span></div>
      <div class="kpi"><b>${wrong.length}</b><span>当前错题</span></div>
      <div class="kpi"><b>${rate}%</b><span>已做题正确率</span></div>
      <div class="kpi"><b>${dueQuestions().length}</b><span>今日待复习</span></div>
    </div>
    <h2 class="section-title">薄弱考点（错题数 / 已做题数）</h2>
    ${barsBlock(weak, 'bad')}
    <h2 class="section-title">错因分布</h2>
    ${barsBlock(countBy(wrong, q => q.errorReasons), 'bad')}
    <h2 class="section-title">各科题量</h2>
    ${barsBlock(countBy(qs, q => q.subject))}
    <h2 class="section-title">来源分布</h2>
    ${barsBlock(countBy(qs, q => q.sourceType || '未填写'))}
    <h2 class="section-title">难度分布</h2>
    ${barsBlock(countBy(qs, q => q.difficulty || '未填写'))}
    <p class="muted small">来源待核实的题：${qs.filter(q => !q.verified).length} 道。建议核对年份、地区和试卷名称后再勾选「来源已核实」。</p>`;
}

/* ========== 数据（备份/恢复） ========== */
function viewData(root) {
  const size = new Blob([JSON.stringify(state.questions)]).size;
  root.innerHTML = `
    <div class="panel">
      <h3>数据保存在哪里</h3>
      <p>所有题目都保存在<strong>当前这台设备的浏览器</strong>里，不会上传到任何服务器。换手机、换浏览器或清除网站数据后看不到原来的题，所以请<strong>定期导出备份</strong>。</p>
      <p class="muted small num">当前 ${state.questions.length} 题，约 ${(size / 1024 / 1024).toFixed(2)} MB（含图片）。</p>
    </div>
    <h2 class="section-title">备份与恢复</h2>
    <div class="row">
      <button type="button" class="btn primary" id="btn-export">导出备份（JSON）</button>
      <label class="btn" for="imp-file">导入备份</label>
      <input type="file" id="imp-file" accept="application/json,.json" hidden>
    </div>
    <p class="muted small">导入时按题目 ID 合并：同一道题保留修改时间较新的版本，不会删除你现有的题。用这个功能也可以把电脑上录的题同步到手机。</p>
    <h2 class="section-title">公式输入</h2>
    <p class="small">题干、答案、解析里可以写 LaTeX 公式：行内用 <code>$v=v_0+at$</code>，单独一行用 <code>$$E_k=\\frac{1}{2}mv^2$$</code>。</p>`;

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'gaokao-tiku', version: 1, exportedAt: new Date().toISOString(), questions: state.questions })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `题库备份-${today()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    try { localStorage.setItem('tiku-last-export', today()); } catch (e) { /* 忽略 */ }
    toast('已导出备份');
  });

  $('#imp-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.questions;
      if (!Array.isArray(list)) throw new Error('格式不对');
      let added = 0, updated = 0;
      for (const raw of list) {
        if (!raw || typeof raw !== 'object' || !raw.id) continue;
        const q = normalize(raw);
        const cur = state.questions.find(x => x.id === q.id);
        if (!cur) { await store.put(q); state.questions.push(q); added++; }
        else if ((q.updatedAt || 0) > (cur.updatedAt || 0)) { await store.put(q); Object.assign(cur, q); updated++; }
      }
      updateDueBadge();
      toast(`导入完成：新增 ${added} 题，更新 ${updated} 题`);
    } catch (err) {
      toast('导入失败：文件不是本题库导出的备份');
    }
    e.target.value = '';
  });
}

function normalize(raw) {
  return {
    id: String(raw.id),
    subject: SUBJECTS.includes(raw.subject) ? raw.subject : '物理',
    sourceType: raw.sourceType || '',
    year: raw.year ? Number(raw.year) : '',
    paper: raw.paper || '',
    number: raw.number ? String(raw.number) : '',
    qtype: raw.qtype || '',
    score: raw.score ? Number(raw.score) : '',
    difficulty: raw.difficulty || '',
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : splitTags(raw.tags),
    content: raw.content || '',
    images: Array.isArray(raw.images) ? raw.images : [],
    answer: raw.answer || '',
    analysis: raw.analysis || '',
    answerImages: Array.isArray(raw.answerImages) ? raw.answerImages : [],
    verified: !!raw.verified,
    status: STATUS[raw.status] ? raw.status : 'new',
    errorReasons: Array.isArray(raw.errorReasons) ? raw.errorReasons : [],
    wrongCount: Number(raw.wrongCount) || 0,
    review: raw.review && raw.review.due ? { stage: Number(raw.review.stage) || 0, due: String(raw.review.due) } : null,
    note: raw.note || '',
    lastDone: raw.lastDone || '',
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

/* ========== 对话框 ========== */
const dlg = $('#dlg');
function openDialog(html, onMount) {
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
  onMount && onMount(dlg);
}
dlg.addEventListener('click', e => {
  // 编辑表单点背景不关闭，避免误触丢失输入
  if (e.target.closest('[data-close]') || (e.target === dlg && !$('#e-form', dlg))) dlg.close();
});

/* ========== 题目详情 ========== */
function imgsHTML(list) {
  return list && list.length ? `<div class="q-imgs">${list.map(src => `<img src="${esc(src)}" alt="题目图片" loading="lazy">`).join('')}</div>` : '';
}

function openDetail(id) {
  const q = state.questions.find(x => x.id === id);
  if (!q) return;
  const hasAnswer = q.answer || q.analysis || (q.answerImages || []).length;
  openDialog(`
    <div class="dlg-head"><h2>${esc(q.subject)} · ${esc(q.qtype || '题目')}</h2>
      <div class="row"><button class="btn sm" type="button" id="d-edit">编辑</button><button class="btn sm" type="button" data-close>关闭</button></div></div>
    <div class="dlg-body">
      <div class="q-meta">
        <span class="tag subj ${subjClass(q.subject)}">${esc(q.subject)}</span>
        ${q.sourceType ? `<span class="tag">${esc(q.sourceType)}</span>` : ''}
        ${q.difficulty ? `<span class="tag">${esc(q.difficulty)}</span>` : ''}
        ${q.score ? `<span class="tag">${esc(q.score)} 分</span>` : ''}
        ${q.verified ? '' : '<span class="tag unverified">来源待核实</span>'}
      </div>
      <div class="q-src">${esc(srcLine(q)) || '未填写来源'}</div>
      ${(q.tags || []).length ? `<div class="row">${q.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="panel"><div class="q-text math">${esc(q.content)}</div>${imgsHTML(q.images)}</div>
      ${hasAnswer ? `<button class="btn reveal" type="button" id="d-reveal">先自己做，做完再看答案与解析</button>
      <div id="d-answer" hidden>
        ${q.answer ? `<div class="panel"><h3>答案</h3><div class="q-text math">${esc(q.answer)}</div></div>` : ''}
        ${q.analysis || (q.answerImages || []).length ? `<div class="panel" style="margin-top:12px"><h3>解析</h3><div class="q-text math">${esc(q.analysis)}</div>${imgsHTML(q.answerImages)}</div>` : ''}
      </div>` : '<p class="muted small">还没有录入答案和解析。</p>'}
      ${q.status === 'wrong' && (q.errorReasons || []).length ? `<div class="small">错因：${q.errorReasons.map(r => `<span class="tag st-wrong">${esc(r)}</span>`).join(' ')}</div>` : ''}
      ${q.note ? `<div class="panel"><h3>我的笔记</h3><div class="q-text math">${esc(q.note)}</div></div>` : ''}
      <div class="panel">
        <h3>这次做的结果</h3>
        <div class="row">
          <button class="btn good grow" type="button" id="d-right">做对了</button>
          <button class="btn bad grow" type="button" id="d-wrong">做错了</button>
        </div>
        <div id="d-reasons" hidden style="margin-top:10px">
          <div class="label small muted">错在哪里（可多选）</div>
          <div class="checks">${ERROR_REASONS.map(r => `<label class="check"><input type="checkbox" value="${r}"${(q.errorReasons || []).includes(r) ? ' checked' : ''}>${r}</label>`).join('')}</div>
          <button class="btn bad" type="button" id="d-wrong-save" style="margin-top:8px">记为错题</button>
        </div>
        <p class="muted small num" style="margin:8px 0 0">状态：${STATUS[q.status]}${q.wrongCount ? ` · 累计错 ${q.wrongCount} 次` : ''}${q.review ? ` · 下次复习 ${q.review.due}` : ''}${q.mastered && !q.review ? ' · 已掌握' : ''}</p>
      </div>
    </div>`, root => {
    renderMath(root);
    const reveal = $('#d-reveal', root);
    if (reveal) reveal.addEventListener('click', () => { $('#d-answer', root).hidden = false; reveal.hidden = true; });
    $('#d-edit', root).addEventListener('click', () => openEditor(q.id));
    $('#d-right', root).addEventListener('click', async () => {
      markResult(q, 'right');
      await saveQuestion(q);
      toast(q.review ? `下次复习：${q.review.due}` : q.mastered ? '这道题已掌握' : '已记录');
      dlg.close(); route();
    });
    $('#d-wrong', root).addEventListener('click', () => { $('#d-reasons', root).hidden = false; });
    $('#d-wrong-save', root).addEventListener('click', async () => {
      const reasons = [...root.querySelectorAll('#d-reasons input:checked')].map(i => i.value);
      markResult(q, 'wrong', reasons);
      await saveQuestion(q);
      toast(`已记为错题，${q.review.due} 复习`);
      dlg.close(); route();
    });
  });
}

/* ========== 录入 / 编辑 ========== */
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, IMG_MAX_SIDE / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', IMG_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function emptyQuestion() {
  // 新题沿用上一题的来源信息，连续录同一份卷子时只需改题号
  let last = {};
  try { last = JSON.parse(localStorage.getItem('tiku-last-source') || '{}'); } catch (e) { /* 忽略 */ }
  return normalize({
    id: uid(),
    subject: last.subject || state.filters.subject || '物理',
    sourceType: last.sourceType || '',
    year: last.year || '',
    paper: last.paper || '',
    verified: !!last.verified,
    number: last.number && /^\d+$/.test(last.number) ? String(Number(last.number) + 1) : '',
  });
}

function openEditor(id) {
  const existing = state.questions.find(x => x.id === id);
  const q = existing ? structuredClone(existing) : emptyQuestion();
  const sel = (name, values, cur, blank = '请选择') =>
    `<select id="e-${name}"><option value="">${blank}</option>${values.map(v => `<option${cur === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;

  openDialog(`
    <form id="e-form" novalidate>
    <div class="dlg-head"><h2>${existing ? '编辑题目' : '录入新题'}</h2>
      <div class="row"><button class="btn sm" type="button" data-close>取消</button><button class="btn sm primary" type="submit">保存</button></div></div>
    <div class="dlg-body">
      <div class="grid2">
        <div class="field"><label for="e-subject" class="req">科目</label>${sel('subject', SUBJECTS, q.subject, '请选择')}</div>
        <div class="field"><label for="e-sourceType">来源类别</label>${sel('sourceType', SOURCE_TYPES, q.sourceType)}</div>
      </div>
      <div class="grid3">
        <div class="field"><label for="e-year">年份</label><input type="number" id="e-year" inputmode="numeric" min="2000" max="2100" placeholder="2025" value="${esc(q.year)}"></div>
        <div class="field"><label for="e-number">题号</label><input type="text" id="e-number" placeholder="13" value="${esc(q.number)}"></div>
        <div class="field"><label for="e-score">分值</label><input type="number" id="e-score" inputmode="numeric" min="0" max="100" value="${esc(q.score)}"></div>
      </div>
      <div class="field"><label for="e-paper" class="req">试卷名称</label>
        <input type="text" id="e-paper" list="dl-papers" placeholder="如：2024年广东高考物理 / 2025届广州一模物理" value="${esc(q.paper)}">
        <datalist id="dl-papers">${allPapers().map(p => `<option value="${esc(p)}">`).join('')}</datalist>
      </div>
      <label class="check"><input type="checkbox" id="e-verified"${q.verified ? ' checked' : ''}> 来源已核实（年份、地区、试卷名称都确认无误）</label>
      <div class="grid2">
        <div class="field"><label for="e-qtype">题型</label>${sel('qtype', QTYPES, q.qtype)}</div>
        <div class="field"><label for="e-difficulty">难度</label>${sel('difficulty', DIFFS, q.difficulty)}</div>
      </div>
      <div class="field"><label for="e-tags">考点（用逗号或空格分隔）</label>
        <input type="text" id="e-tags" list="dl-tags" placeholder="如：动量守恒 板块模型" value="${esc((q.tags || []).join(' '))}">
        <datalist id="dl-tags">${allTags().map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      </div>
      <div class="field"><label for="e-content">题干（可留空，只传图片）</label><textarea id="e-content" rows="5" placeholder="公式用 $...$ 包裹">${esc(q.content)}</textarea></div>
      <div class="field"><span class="label">题目图片</span><div class="thumbs" id="e-images"></div>
        <label class="btn" for="e-img-file" style="justify-self:start">拍照 / 选图片</label>
        <input type="file" id="e-img-file" accept="image/*" multiple hidden></div>
      <div class="field"><label for="e-answer">答案</label><textarea id="e-answer" rows="2">${esc(q.answer)}</textarea></div>
      <div class="field"><label for="e-analysis">解析</label><textarea id="e-analysis" rows="5">${esc(q.analysis)}</textarea></div>
      <div class="field"><span class="label">答案 / 解析图片</span><div class="thumbs" id="e-answerImages"></div>
        <label class="btn" for="e-ans-file" style="justify-self:start">拍照 / 选图片</label>
        <input type="file" id="e-ans-file" accept="image/*" multiple hidden></div>
      <div class="field"><label for="e-note">我的笔记（解题入口、易错点、同类题识别方法）</label><textarea id="e-note" rows="3">${esc(q.note)}</textarea></div>
      ${existing ? `<div id="e-del-area"><button class="btn danger" type="button" id="e-del">删除这道题</button></div>` : ''}
      <p class="muted small" id="e-err" role="alert"></p>
    </div>
    </form>`, root => {
    const drawThumbs = key => {
      const box = $('#e-' + key, root);
      box.innerHTML = q[key].map((src, i) => `<div class="thumb"><img src="${esc(src)}" alt=""><button type="button" data-i="${i}" aria-label="删除图片">×</button></div>`).join('');
    };
    const bindImages = (key, inputId) => {
      drawThumbs(key);
      $('#e-' + key, root).addEventListener('click', e => {
        const b = e.target.closest('button[data-i]'); if (!b) return;
        q[key].splice(Number(b.dataset.i), 1); drawThumbs(key);
      });
      $(inputId, root).addEventListener('change', async e => {
        for (const f of e.target.files) {
          try { q[key].push(await compressImage(f)); } catch (err) { toast('有一张图片读取失败'); }
        }
        e.target.value = '';
        drawThumbs(key);
      });
    };
    bindImages('images', '#e-img-file');
    bindImages('answerImages', '#e-ans-file');

    const del = $('#e-del', root);
    if (del) del.addEventListener('click', () => {
      $('#e-del-area', root).innerHTML = `<div class="confirm row"><span class="grow">确定删除？删除后无法恢复。</span>
        <button class="btn sm" type="button" id="e-del-no">再想想</button><button class="btn sm danger" type="button" id="e-del-yes">删除</button></div>`;
      $('#e-del-no', root).addEventListener('click', () => openEditor(id));
      $('#e-del-yes', root).addEventListener('click', async () => {
        await deleteQuestion(id); dlg.close(); toast('已删除'); route();
      });
    });

    $('#e-form', root).addEventListener('submit', async e => {
      e.preventDefault();
      const v = k => $('#e-' + k, root).value.trim();
      q.subject = v('subject');
      q.sourceType = v('sourceType');
      q.year = v('year') ? Number(v('year')) : '';
      q.number = v('number');
      q.score = v('score') ? Number(v('score')) : '';
      q.paper = v('paper');
      q.verified = $('#e-verified', root).checked;
      q.qtype = v('qtype');
      q.difficulty = v('difficulty');
      q.tags = splitTags(v('tags'));
      q.content = $('#e-content', root).value;
      q.answer = $('#e-answer', root).value;
      q.analysis = $('#e-analysis', root).value;
      q.note = $('#e-note', root).value;

      const err = [];
      if (!q.subject) err.push('请选择科目');
      if (!q.paper) err.push('请填写试卷名称（题目来源必须可追溯）');
      if (!q.content.trim() && !q.images.length) err.push('题干文字和题目图片至少要有一个');
      if (err.length) { $('#e-err', root).textContent = err.join('；'); return; }

      try {
        await saveQuestion(q);
      } catch (ex) {
        $('#e-err', root).textContent = '保存失败：浏览器存储空间可能不足，请先导出备份并删除部分图片。';
        return;
      }
      try {
        localStorage.setItem('tiku-last-source', JSON.stringify({ subject: q.subject, sourceType: q.sourceType, year: q.year, paper: q.paper, verified: q.verified, number: q.number }));
      } catch (ex) { /* 忽略 */ }
      toast(existing ? '已保存' : '已录入，可以继续录下一题');
      if (existing) openDetail(q.id); else { dlg.close(); route(); }
    });
  });
}

/* ========== 启动 ========== */
async function main() {
  loadFilters();
  try {
    await store.open();
    state.questions = (await store.all()).map(normalize);
  } catch (e) {
    $('#app').innerHTML = '<div class="empty"><strong>无法打开本地数据库</strong>请关闭无痕/隐私模式后重试。</div>';
    return;
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  $('#btn-add').addEventListener('click', () => openEditor(null));
  $('#app').addEventListener('click', e => {
    const b = e.target.closest('.item, .qnum'); if (b) openDetail(b.dataset.id);
  });
  window.addEventListener('hashchange', route);
  updateDueBadge();
  route();
}

main();

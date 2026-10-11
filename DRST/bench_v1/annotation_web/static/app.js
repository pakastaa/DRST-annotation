const state = {
  me: null, tasks: [], current: null, trajectory: null, codebook: null,
  modelAnnotations: [], revision: 0, payload: null,
  activeReview: null, activeEditor: null, evidenceRole: 'prior',
};

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const STATUS = {unstarted: '未开始', draft: '草稿', submitted: '已提交'};
const DIMENSIONS = {belief: '信念', trust: '信任', commitment: '承诺', emotion: '情绪'};
const LABELS = {
  unknown: '无法判断', reject: '否定', uncertain: '不确定', accept: '接受',
  distrust: '不信任', trust: '信任', none: '无承诺', considering: '考虑中',
  conditional: '有条件', committed: '已承诺', withdrawn: '已撤回',
  neutral: '中性', joy: '喜悦', anger: '愤怒', sadness: '悲伤', fear: '恐惧',
  disgust: '厌恶', surprise: '惊讶', mixed: '混合',
};
const EFFECTIVE = {pre_response: '对方发言后', post_response: '目标角色回复后'};
const VISIBILITY = {direct: '直接表达', reported: '转述信息', inferred: '根据语境推断'};
const REVIEW_SCHEMA = 'strict_event_review_v2';
const REASONS = {
  insufficient_prior: '前态证据不足', insufficient_after: '后态证据不足',
  no_transition: '没有明确变化', object_unclear: '状态对象不清楚',
  low_benchmark_value: '评测价值较低', future_context: '依赖后文或外部信息',
  duplicate: '与其他事件重复', out_of_scope: '不属于目标角色状态', other: '其他原因',
};
const SCREENING = {
  A_auto_clear: 'A · 自动检查较清晰',
  B_needs_review: 'B · 需要重点复核',
  legacy_candidate: '待人工复核',
};

async function api(path, options = {}) {
  options.headers = {'Content-Type': 'application/json', ...(options.headers || {})};
  if (state.me && options.method === 'POST') options.headers['X-CSRF-Token'] = state.me.csrf;
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({error: response.statusText}));
  if (!response.ok) throw data;
  return data;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
}

async function bootstrap() {
  try {
    state.me = await api('/api/me');
    showApp();
    await loadTasks();
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
}

function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#userLabel').textContent = state.me.username;
  $('#exportBtn').classList.toggle('hidden', state.me.role !== 'admin');
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    state.me = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({username: $('#username').value.trim(), password: $('#password').value}),
    });
    showApp();
    await loadTasks();
  } catch (error) {
    $('#loginError').textContent = error.error || '登录失败';
  }
});

$('#logoutBtn').onclick = async () => {
  await api('/api/logout', {method: 'POST', body: '{}'}).catch(() => {});
  state.me = null;
  state.current = null;
  showLogin();
};
$('#exportBtn').onclick = () => { location.href = '/api/export'; };
$('#helpBtn').onclick = () => $('#helpDialog').showModal();
$('#closeHelp').onclick = () => $('#helpDialog').close();
$('#helpDialog').addEventListener('click', event => {
  if (event.target === $('#helpDialog')) $('#helpDialog').close();
});

async function loadTasks() {
  state.tasks = (await api('/api/tasks')).tasks;
  const sources = [...new Set(state.tasks.map(task => task.source))].sort();
  const currentSource = $('#sourceFilter').value;
  $('#sourceFilter').innerHTML = '<option value="all">全部来源</option>' +
    sources.map(source => `<option value="${esc(source)}">${esc(source)}</option>`).join('');
  if (sources.includes(currentSource)) $('#sourceFilter').value = currentSource;
  renderTasks();
  updateProgress();
}

function updateProgress() {
  const submitted = state.tasks.filter(task => task.status === 'submitted').length;
  const drafts = state.tasks.filter(task => task.status === 'draft').length;
  const percent = state.tasks.length ? 100 * submitted / state.tasks.length : 0;
  $('#progressText').textContent = `${submitted} / ${state.tasks.length} 已复核`;
  $('#progressBar').style.width = `${percent}%`;
  $('#taskSummary').textContent = `已提交 ${submitted} · 草稿 ${drafts} · 未开始 ${state.tasks.length - submitted - drafts}`;
}

function filteredTasks() {
  const query = $('#taskSearch').value.trim().toLowerCase();
  const status = $('#taskFilter').value;
  const source = $('#sourceFilter').value;
  return state.tasks.filter(task =>
    (status === 'all' || task.status === status) &&
    (source === 'all' || task.source === source) &&
    `${task.trajectory_id} ${task.source} ${task.target_character}`.toLowerCase().includes(query)
  );
}

function renderTasks() {
  const visible = filteredTasks();
  $('#taskList').innerHTML = visible.length ? visible.map(task => `
    <button class="task ${state.current === task.trajectory_id ? 'active' : ''}" data-id="${esc(task.trajectory_id)}">
      <div class="task-top"><span>${esc(task.source)} · ${task.round_count} 轮</span><span class="badge ${task.status}">${STATUS[task.status]}</span></div>
      <div class="task-title">${esc(task.target_character)}</div>
      <div class="task-sub">待复核候选 ${task.model_event_count} 条</div>
      <div class="task-id">${esc(task.trajectory_id)}</div>
    </button>`).join('') : '<div class="no-result">没有符合条件的任务</div>';
  document.querySelectorAll('.task').forEach(element => {
    element.onclick = () => openTask(element.dataset.id);
  });
}

$('#taskSearch').oninput = renderTasks;
$('#taskFilter').onchange = renderTasks;
$('#sourceFilter').onchange = renderTasks;

function blankPayload() {
  return {
    review_schema: REVIEW_SCHEMA,
    reviews: state.modelAnnotations.map(event => ({
      event_id: event.event_id, decision: '', final_event: null, reason: '', notes: '',
    })),
    added_events: [], notes: '',
  };
}

function normalizedPayload(saved) {
  if (!saved || saved.review_schema !== REVIEW_SCHEMA) return blankPayload();
  const known = new Map((saved.reviews || []).map(review => [review.event_id, review]));
  return {
    review_schema: REVIEW_SCHEMA,
    reviews: state.modelAnnotations.map(event => known.get(event.event_id) || {
      event_id: event.event_id, decision: '', final_event: null, reason: '', notes: '',
    }),
    added_events: Array.isArray(saved.added_events) ? saved.added_events : [],
    notes: saved.notes || '',
  };
}

async function openTask(id) {
  const data = await api('/api/tasks/' + encodeURIComponent(id));
  state.current = id;
  state.trajectory = data.trajectory;
  state.codebook = data.codebook;
  state.modelAnnotations = data.model_annotations || [];
  state.revision = data.annotation?.revision || 0;
  state.payload = normalizedPayload(data.annotation?.payload);
  state.activeReview = state.modelAnnotations.length ? 0 : null;
  state.activeEditor = null;
  renderTasks();
  renderMain();
  $('#mainPanel').scrollTo({top: 0, behavior: 'smooth'});
}

function taskPosition() {
  const index = state.tasks.findIndex(task => task.trajectory_id === state.current);
  return {index, total: state.tasks.length};
}

function navigate(offset) {
  const {index, total} = taskPosition();
  const next = index + offset;
  if (next >= 0 && next < total) openTask(state.tasks[next].trajectory_id);
}

function nextIncomplete(afterId) {
  const start = state.tasks.findIndex(task => task.trajectory_id === afterId);
  for (let step = 1; step <= state.tasks.length; step += 1) {
    const task = state.tasks[(start + step) % state.tasks.length];
    if (task.status !== 'submitted') return task.trajectory_id;
  }
  return null;
}

function itemLookup() {
  const lookup = {};
  state.trajectory.rounds.forEach(round => {
    lookup[round.incoming.item_id] = `第 ${round.round_id} 轮 · 对方发言`;
    lookup[round.target_response.item_id] = `第 ${round.round_id} 轮 · 目标回复`;
  });
  return lookup;
}

function reviewedCount() {
  return state.payload.reviews.filter(review => ['accept', 'edit', 'ambiguous', 'exclude'].includes(review.decision)).length;
}

function renderMain() {
  const trajectory = state.trajectory;
  const source = trajectory.source?.dataset || 'unknown';
  const {index, total} = taskPosition();
  $('#mainPanel').innerHTML = `
    <div class="task-toolbar">
      <button id="prevTask" class="ghost compact" ${index <= 0 ? 'disabled' : ''}>← 上一条</button>
      <span>任务 ${index + 1} / ${total}</span>
      <button id="nextTask" class="ghost compact" ${index >= total - 1 ? 'disabled' : ''}>下一条 →</button>
    </div>
    <div class="task-header">
      <div>
        <p class="eyebrow">${esc(source)} · ${trajectory.rounds.length} 轮对话</p>
        <h1>目标角色：${esc(trajectory.target_character)}</h1>
        <div class="meta">
          <span>对话者：${esc((trajectory.interlocutors || []).join(', '))}</span>
          <span>时序审核：${esc(trajectory.profile_temporal_audit)}</span>
          <span>${esc(trajectory.trajectory_id)}</span>
        </div>
      </div>
    </div>
    <details class="profile">
      <summary>查看初始人物档案（仅作为对话开始时的参考）</summary>
      <pre>${esc(JSON.stringify(trajectory.initial_profile, null, 2))}</pre>
    </details>
    <div class="workspace">
      <section class="rounds" aria-label="对话内容">${trajectory.rounds.map(roundHTML).join('')}</section>
      <section class="annotation review-panel" aria-label="模型标注复核面板">
        <div class="annotation-title">
          <div><p class="step-label">候选生成 + 独立风险分层</p><h2>待复核 ${state.modelAnnotations.length} 条状态事件</h2></div>
          <button id="inlineHelp" class="link-button">复核说明</button>
        </div>
        <div class="review-summary"><span id="reviewCount">已处理 ${reviewedCount()} / ${state.modelAnnotations.length}</span><i><b id="reviewBar"></b></i></div>
        <p class="hint">只保留“前态有依据、后态有依据、变化明确且值得评测”的事件。蓝色为前态证据，紫色为后态证据。</p>
        <div id="modelReviewList" class="model-review-list"></div>
        <label class="notes-field">整条任务备注（可选）<textarea id="notes" rows="3" placeholder="记录整体疑问或需要裁决的内容"></textarea></label>
        <div class="actions"><button id="saveDraft" class="ghost">保存复核草稿</button><button id="submitTask" class="primary">提交并下一条</button></div>
        <p id="validationError" class="error validation-error" role="alert"></p>
      </section>
    </div>`;

  $('#prevTask').onclick = () => navigate(-1);
  $('#nextTask').onclick = () => navigate(1);
  $('#inlineHelp').onclick = () => $('#helpDialog').showModal();
  $('#notes').value = state.payload.notes || '';
  $('#notes').oninput = () => { state.payload.notes = $('#notes').value; };
  $('#saveDraft').onclick = () => save(false);
  $('#submitTask').onclick = () => save(true);
  document.querySelectorAll('.evidence-check').forEach(checkbox => {
    checkbox.onchange = () => toggleEvidence(checkbox.dataset.item, checkbox.checked);
  });
  renderReviews();
}

function roundHTML(round) {
  return `<article class="round">
    <div class="round-title"><span>ROUND ${round.round_id}</span><span>第 ${round.round_id} 轮</span></div>
    ${utteranceHTML(round.incoming, '对方发言', 'incoming')}
    ${utteranceHTML(round.target_response, '目标角色回复', 'target')}
  </article>`;
}

function utteranceHTML(item, label, className) {
  return `<div class="utterance ${className}" data-item-row="${esc(item.item_id)}">
    <label class="evidence-control" title="修改模型事件时，将这句话作为最终证据">
      <input class="evidence-check" type="checkbox" data-item="${esc(item.item_id)}">
      <span>证据</span>
    </label>
    <div>
      <div class="speaker">${esc(label)} · ${esc(item.speaker)}</div>
      <div class="text">${esc(item.text)}</div>
      <div class="item-id">${esc(item.item_id)}</div>
    </div>
  </div>`;
}

function modelEventHTML(event, review, index) {
  const lookup = itemLookup();
  const priorEvidence = (event.prior_evidence || []).map(id => lookup[id] || id);
  const afterEvidence = (event.after_evidence || []).map(id => lookup[id] || id);
  const decisionLabel = {accept: '保留', edit: '已修改', ambiguous: '存疑', exclude: '已排除'}[review.decision] || '待复核';
  const needsReason = ['ambiguous', 'exclude'].includes(review.decision);
  const critic = event.critic_assessment || {};
  const riskText = SCREENING[event.screening_tier] || event.screening_tier || '待人工复核';
  const uncertainty = (critic.uncertainties || []).join('、');
  return `<article class="model-review-card ${state.activeReview === index ? 'active' : ''} ${review.decision || 'pending'}" data-review-index="${index}">
    <div class="model-card-head">
      <div><span class="model-index">建议 ${index + 1}</span><span class="dimension-pill ${event.dimension}">${DIMENSIONS[event.dimension]} · ${event.dimension}</span></div>
      <span class="review-state">${decisionLabel}</span>
    </div>
    <div class="screening-banner ${event.screening_tier === 'A_auto_clear' ? 'tier-a' : 'tier-b'}"><b>${esc(riskText)}</b><span>${esc(event.critic_model || event.label_source || '')}${uncertainty ? ` · 风险：${esc(uncertainty)}` : ''}</span></div>
    <div class="evaluation-question"><small>评测问题</small>${esc(event.evaluation_question)}</div>
    <div class="model-object"><small>状态对象</small>${esc(event.object)}</div>
    <div class="model-transition"><span>${LABELS[event.prior] || event.prior}<small>${event.prior}</small></span><b>→</b><span>${LABELS[event.after] || event.after}<small>${event.after}</small></span></div>
    <div class="model-meta"><span>第 ${event.round_id} 轮</span><span>${EFFECTIVE[event.effective_at]}</span><span>${VISIBILITY[event.visibility]}</span><span>${event.benchmark_value === 'core' ? '核心评测项' : '辅助评测项'}</span></div>
    <div class="model-evidence-list prior"><b>前态证据</b>${priorEvidence.map(text => `<span>${esc(text)}</span>`).join('') || '<span>无</span>'}<q>${esc(event.prior_quote)}</q></div>
    <div class="model-evidence-list after"><b>后态证据</b>${afterEvidence.map(text => `<span>${esc(text)}</span>`).join('') || '<span>无</span>'}<q>${esc(event.after_quote)}</q></div>
    <p class="model-rationale"><b>为何值得评测：</b>${esc(event.rationale)}</p>
    <div class="review-actions">
      <button class="review-button accept ${review.decision === 'accept' ? 'selected' : ''}" data-review-action="accept" data-index="${index}">✓ 保留</button>
      <button class="review-button edit ${review.decision === 'edit' ? 'selected' : ''}" data-review-action="edit" data-index="${index}">✎ 修改</button>
      <button class="review-button ambiguous ${review.decision === 'ambiguous' ? 'selected' : ''}" data-review-action="ambiguous" data-index="${index}">? 存疑</button>
      <button class="review-button exclude ${review.decision === 'exclude' ? 'selected' : ''}" data-review-action="exclude" data-index="${index}">× 排除</button>
    </div>
    ${review.decision === 'edit' ? `<div class="edit-box"><p class="edit-title">人工修正后的事件</p>${eventEditorHTML(review.final_event, 'review', index)}</div>` : ''}
    ${needsReason ? `<div class="review-note"><label>原因（必选）<select data-review-reason="${index}"><option value="">请选择</option>${Object.entries(REASONS).map(([value, label]) => option(value, review.reason, label)).join('')}</select></label><label>补充说明（可选）<textarea data-review-note="${index}" rows="2" placeholder="说明具体是哪处证据或状态存在问题">${esc(review.notes || '')}</textarea></label></div>` : ''}
  </article>`;
}

function cloneEvent(event) {
  return {
    round_id: event.round_id, dimension: event.dimension, object: event.object,
    prior: event.prior, after: event.after, effective_at: event.effective_at,
    visibility: event.visibility,
    prior_evidence: [...(event.prior_evidence || [])], after_evidence: [...(event.after_evidence || [])],
    prior_quote: event.prior_quote || '', after_quote: event.after_quote || '',
    evaluation_question: event.evaluation_question || '', rationale: event.rationale || '',
    benchmark_value: event.benchmark_value || 'core',
  };
}

function reviewAction(index, action) {
  const review = state.payload.reviews[index];
  review.decision = action;
  if (action === 'edit') {
    review.final_event = review.final_event || cloneEvent(state.modelAnnotations[index]);
    state.activeEditor = {kind: 'review', index};
    state.evidenceRole = 'prior';
  } else {
    review.final_event = null;
    state.activeEditor = null;
  }
  if (!['ambiguous', 'exclude'].includes(action)) review.reason = '';
  state.activeReview = index;
  renderReviews();
}

function addMissingEvent() {
  state.payload.added_events.push({
    round_id: 1, dimension: 'belief', object: '', prior: 'unknown', after: 'uncertain',
    effective_at: 'pre_response', visibility: 'direct', evidence: [], emotion_intensity: null,
  });
  state.activeReview = null;
  state.activeEditor = {kind: 'added', index: state.payload.added_events.length - 1};
  renderReviews();
}

function option(value, current, label) {
  return `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;
}

function eventEditorHTML(event, kind, index) {
  const labels = (state.codebook[event.dimension] || []).filter(label => label !== 'unknown');
  const rounds = state.trajectory.rounds.length;
  return `<div class="editable-event" data-editor-kind="${kind}" data-editor-index="${index}">
    <div class="grid2">
      <label>发生轮次<select data-field="round_id">${Array.from({length: rounds}, (_, i) => option(i + 1, event.round_id, `第 ${i + 1} 轮`)).join('')}</select></label>
      <label>状态维度<select data-field="dimension">${Object.keys(state.codebook).map(dimension => option(dimension, event.dimension, `${DIMENSIONS[dimension]} (${dimension})`)).join('')}</select></label>
    </div>
    <label>状态对象<input data-field="object" value="${esc(event.object)}" placeholder="命题、人物或行动" ${event.dimension === 'emotion' ? 'readonly' : ''}></label>
    <div class="transition-row">
      <label>变化前<select data-field="prior">${labels.map(label => option(label, event.prior, `${LABELS[label] || label} (${label})`)).join('')}</select></label>
      <span>→</span>
      <label>变化后<select data-field="after">${labels.map(label => option(label, event.after, `${LABELS[label] || label} (${label})`)).join('')}</select></label>
    </div>
    <div class="grid2">
      <label>何时生效<select data-field="effective_at">${option('post_response', event.effective_at, '目标角色回复后 (post_response)')}</select></label>
      <label>证据类型<select data-field="visibility">${Object.keys(VISIBILITY).map(value => option(value, event.visibility, `${VISIBILITY[value]} (${value})`)).join('')}</select></label>
    </div>
    <label>评测问题<input data-field="evaluation_question" value="${esc(event.evaluation_question)}" placeholder="不泄露答案的中性问题"></label>
    <label>评测价值说明<textarea data-field="rationale" rows="2" placeholder="说明这个变化为什么值得测试">${esc(event.rationale)}</textarea></label>
    <label>评测价值<select data-field="benchmark_value">${option('core', event.benchmark_value, '核心评测项')}${option('supporting', event.benchmark_value, '辅助评测项')}</select></label>
    <div class="evidence-role-switch">
      <button type="button" data-evidence-role="prior" class="${state.evidenceRole === 'prior' ? 'selected' : ''}">选择前态证据</button>
      <button type="button" data-evidence-role="after" class="${state.evidenceRole === 'after' ? 'selected' : ''}">选择后态证据</button>
    </div>
    <div class="grid2">
      <label>前态原文短引文<input data-field="prior_quote" value="${esc(event.prior_quote)}" placeholder="从前态证据中原样复制"></label>
      <label>后态原文短引文<input data-field="after_quote" value="${esc(event.after_quote)}" placeholder="从后态证据中原样复制"></label>
    </div>
    <div class="selected-evidence prior"><b>前态证据 ${(event.prior_evidence || []).length} 条</b><span>${(event.prior_evidence || []).map(esc).join('<br>') || '请切到“前态证据”并勾选左侧目标回复'}</span></div>
    <div class="selected-evidence after"><b>后态证据 ${(event.after_evidence || []).length} 条</b><span>${(event.after_evidence || []).map(esc).join('<br>') || '请切到“后态证据”并勾选左侧目标回复'}</span></div>
  </div>`;
}

function addedEventHTML(event, index) {
  const active = state.activeEditor?.kind === 'added' && state.activeEditor.index === index;
  return `<article class="added-event-card ${active ? 'active' : ''}" data-added-index="${index}">
    <div class="event-head"><div><span>新增事件 ${index + 1}</span><small>模型漏标</small></div><button class="danger compact remove-added" data-index="${index}">删除</button></div>
    ${eventEditorHTML(event, 'added', index)}
  </article>`;
}

function renderReviews() {
  const list = $('#modelReviewList');
  if (!list) return;
  list.innerHTML = state.modelAnnotations.length
    ? state.modelAnnotations.map((event, index) => modelEventHTML(event, state.payload.reviews[index], index)).join('')
    : '<div class="event-empty"><b>当前轨迹没有严格候选</b><span>该轨迹不会进入本轮复核。</span></div>';

  const count = reviewedCount();
  $('#reviewCount').textContent = `已处理 ${count} / ${state.modelAnnotations.length}`;
  $('#reviewBar').style.width = `${state.modelAnnotations.length ? 100 * count / state.modelAnnotations.length : 100}%`;

  document.querySelectorAll('.model-review-card').forEach(card => {
    card.onclick = event => {
      if (event.target.closest('button,input,select,textarea,label')) return;
      const index = Number(card.dataset.reviewIndex);
      state.activeReview = index;
      state.activeEditor = state.payload.reviews[index].decision === 'edit' ? {kind: 'review', index} : null;
      renderReviews();
    };
  });
  document.querySelectorAll('[data-review-action]').forEach(button => {
    button.onclick = () => reviewAction(Number(button.dataset.index), button.dataset.reviewAction);
  });
  document.querySelectorAll('[data-review-note]').forEach(textarea => {
    textarea.oninput = () => { state.payload.reviews[Number(textarea.dataset.reviewNote)].notes = textarea.value; };
  });
  document.querySelectorAll('[data-review-reason]').forEach(select => {
    select.onchange = () => { state.payload.reviews[Number(select.dataset.reviewReason)].reason = select.value; };
  });
  document.querySelectorAll('[data-evidence-role]').forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      state.evidenceRole = button.dataset.evidenceRole;
      renderReviews();
    };
  });
  document.querySelectorAll('.added-event-card').forEach(card => {
    card.onclick = event => {
      if (event.target.closest('button,input,select,textarea,label')) return;
      state.activeReview = null;
      state.activeEditor = {kind: 'added', index: Number(card.dataset.addedIndex)};
      renderReviews();
    };
  });
  document.querySelectorAll('[data-field]').forEach(element => {
    element.onchange = () => updateEventField(element);
    if (['INPUT', 'TEXTAREA'].includes(element.tagName)) element.oninput = () => updateEventField(element, false);
  });
  document.querySelectorAll('.remove-added').forEach(button => {
    button.onclick = () => {
      state.payload.added_events.splice(Number(button.dataset.index), 1);
      state.activeEditor = null;
      renderReviews();
    };
  });
  syncEvidenceChecks();
}

function editableEvent(kind, index) {
  if (kind === 'review') return state.payload.reviews[index].final_event;
  return state.payload.added_events[index];
}

function activeEditableEvent() {
  if (!state.activeEditor) return null;
  return editableEvent(state.activeEditor.kind, state.activeEditor.index);
}

function updateEventField(element, rerender = true) {
  const editor = element.closest('.editable-event');
  const event = editableEvent(editor.dataset.editorKind, Number(editor.dataset.editorIndex));
  const field = element.dataset.field;
  event[field] = field === 'round_id' ? Number(element.value) : element.value;
  if (field === 'dimension') {
    const dimension = element.value;
    event.object = dimension === 'emotion' ? 'self' : '';
    const labels = state.codebook[dimension].filter(label => label !== 'unknown');
    event.prior = labels[0];
    event.after = labels[1];
  }
  if (rerender) renderReviews();
}

function toggleEvidence(itemId, checked) {
  const event = activeEditableEvent();
  if (!event) {
    toast('请先选择“修改”或新增一个漏标事件');
    syncEvidenceChecks();
    return;
  }
  const field = state.evidenceRole === 'after' ? 'after_evidence' : 'prior_evidence';
  const other = field === 'after_evidence' ? 'prior_evidence' : 'after_evidence';
  event[field] = event[field] || [];
  event[other] = event[other] || [];
  if (checked && !event[field].includes(itemId)) {
    event[field].push(itemId);
    event[other] = event[other].filter(id => id !== itemId);
  }
  if (!checked) event[field] = event[field].filter(id => id !== itemId);
  renderReviews();
}

function syncEvidenceChecks() {
  const editable = activeEditableEvent();
  const finalEvidence = new Set(editable?.[state.evidenceRole === 'after' ? 'after_evidence' : 'prior_evidence'] || []);
  const model = state.activeReview === null ? null : state.modelAnnotations[state.activeReview];
  const modelPrior = new Set(model?.prior_evidence || []);
  const modelAfter = new Set(model?.after_evidence || []);
  document.querySelectorAll('.evidence-check').forEach(checkbox => {
    checkbox.checked = finalEvidence.has(checkbox.dataset.item);
    const row = checkbox.closest('.utterance');
    checkbox.disabled = !editable || !row?.classList.contains('target');
    row?.classList.toggle('evidence-selected', checkbox.checked);
    row?.classList.toggle('model-prior-evidence', modelPrior.has(checkbox.dataset.item));
    row?.classList.toggle('model-after-evidence', modelAfter.has(checkbox.dataset.item));
  });
}

async function save(submit) {
  $('#validationError').textContent = '';
  const currentId = state.current;
  try {
    const result = await api('/api/tasks/' + encodeURIComponent(currentId), {
      method: 'POST',
      body: JSON.stringify({revision: state.revision, submit, payload: state.payload}),
    });
    state.revision = result.revision;
    await loadTasks();
    if (submit) {
      const nextId = nextIncomplete(currentId);
      if (nextId) {
        toast('复核已提交，进入下一条未完成任务');
        await openTask(nextId);
      } else {
        toast('全部任务已复核完成');
        await openTask(currentId);
      }
    } else {
      toast('复核草稿已保存');
      renderMain();
    }
  } catch (error) {
    $('#validationError').textContent = (error.details || [error.error || '保存失败']).join('；');
  }
}

bootstrap();

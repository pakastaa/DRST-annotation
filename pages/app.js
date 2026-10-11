/* global supabase, DRST_CONFIG */
const db = supabase.createClient(DRST_CONFIG.supabaseUrl, DRST_CONFIG.supabasePublishableKey);
const state = { user: null, tasks: [], events: new Map(), current: null, review: null };
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const statuses = {unstarted: '未开始', draft: '草稿', submitted: '已提交'};
const dimensions = {belief: '信念', trust: '信任', commitment: '承诺', emotion: '情绪'};
const decisions = {accept: '保留', edit: '修改', ambiguous: '存疑', exclude: '排除'};
const reasons = {insufficient_prior: '前态证据不足', insufficient_after: '后态证据不足', no_transition: '没有明确变化', object_unclear: '状态对象不清楚', low_benchmark_value: '评测价值较低', future_context: '依赖后文或外部信息', duplicate: '与其他事件重复', out_of_scope: '不属于目标角色状态', other: '其他原因'};

function toast(text) { const el = $('#toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2600); }
function errorText(error) { return error?.message || error?.error_description || '操作失败，请稍后重试'; }

async function bootstrap() {
  const {data: {session}} = await db.auth.getSession();
  if (!session) return showLogin();
  state.user = session.user;
  showApp();
  await loadTasks();
}
function showLogin() { $('#loginView').classList.remove('hidden'); $('#appView').classList.add('hidden'); }
function showApp() { $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden'); $('#userLabel').textContent = state.user.email; }

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('#loginError').textContent = '';
  const {data, error} = await db.auth.signInWithPassword({email: $('#email').value.trim(), password: $('#password').value});
  if (error) return ($('#loginError').textContent = errorText(error));
  state.user = data.user; showApp(); await loadTasks();
});
$('#signUpBtn').onclick = async () => {
  $('#loginError').textContent = '';
  const email = $('#email').value.trim(), password = $('#password').value;
  if (!email || password.length < 8) return ($('#loginError').textContent = '请填写邮箱，并设置至少 8 位密码。');
  const {data, error} = await db.auth.signUp({email, password, options: {emailRedirectTo: window.location.href}});
  if (error) return ($('#loginError').textContent = errorText(error));
  if (!data.session) $('#loginError').textContent = '请前往邮箱完成确认后再登录。';
  else { state.user = data.user; showApp(); await loadTasks(); }
};
$('#logoutBtn').onclick = async () => { await db.auth.signOut(); state.user = null; state.current = null; showLogin(); };
$('#helpBtn').onclick = () => $('#helpDialog').showModal();
$('#closeHelp').onclick = () => $('#helpDialog').close();
$('#helpDialog').addEventListener('click', event => { if (event.target === $('#helpDialog')) $('#helpDialog').close(); });

async function loadTasks() {
  const [{data: tasks, error: taskError}, {data: reviews, error: reviewError}] = await Promise.all([
    db.from('annotation_tasks').select('trajectory_id,source,target_character,round_count,event_count').order('trajectory_id'),
    db.from('annotation_reviews').select('trajectory_id,status,revision,payload,updated_at').eq('user_id', state.user.id),
  ]);
  if (taskError || reviewError) return showSetupError(errorText(taskError || reviewError));
  const saved = new Map((reviews || []).map(row => [row.trajectory_id, row]));
  state.tasks = (tasks || []).map(task => ({...task, ...(saved.get(task.trajectory_id) || {status:'unstarted', revision:0, payload:null})}));
  const sources = [...new Set(state.tasks.map(task => task.source))].sort();
  $('#sourceFilter').innerHTML = '<option value="all">全部来源</option>' + sources.map(source => `<option value="${esc(source)}">${esc(source)}</option>`).join('');
  renderTasks(); updateProgress();
}
function showSetupError(message) { $('#mainPanel').innerHTML = `<div class="empty-state"><div class="empty-icon">!</div><h2>尚未完成数据库初始化</h2><p>${esc(message)}</p><p>请由项目管理员执行仓库中的 <code>supabase/schema.sql</code>，然后导入任务。</p></div>`; }
function updateProgress() { const done = state.tasks.filter(t => t.status === 'submitted').length, draft = state.tasks.filter(t => t.status === 'draft').length; $('#progressText').textContent = `${done} / ${state.tasks.length} 已复核`; $('#progressBar').style.width = `${state.tasks.length ? done * 100 / state.tasks.length : 0}%`; $('#taskSummary').textContent = `已提交 ${done} · 草稿 ${draft} · 未开始 ${state.tasks.length - done - draft}`; }
function visibleTasks() { const q = $('#taskSearch').value.trim().toLowerCase(), status = $('#taskFilter').value, source = $('#sourceFilter').value; return state.tasks.filter(t => (status === 'all' || t.status === status) && (source === 'all' || t.source === source) && `${t.trajectory_id} ${t.source} ${t.target_character}`.toLowerCase().includes(q)); }
function renderTasks() { const rows = visibleTasks(); $('#taskList').innerHTML = rows.length ? rows.map(t => `<button class="task ${state.current?.trajectory_id === t.trajectory_id ? 'active' : ''}" data-id="${esc(t.trajectory_id)}"><div class="task-top"><span>${esc(t.source)} · ${t.round_count} 轮</span><span class="badge ${t.status}">${statuses[t.status]}</span></div><div class="task-title">${esc(t.target_character)}</div><div class="task-sub">待复核候选 ${t.event_count} 条</div><div class="task-id">${esc(t.trajectory_id)}</div></button>`).join('') : '<div class="no-result">没有符合条件的任务</div>'; document.querySelectorAll('.task').forEach(el => el.onclick = () => openTask(el.dataset.id)); }
$('#taskSearch').oninput = renderTasks; $('#taskFilter').onchange = renderTasks; $('#sourceFilter').onchange = renderTasks;

async function openTask(id) {
  const [{data: task, error: taskError}, {data: events, error: eventError}] = await Promise.all([
    db.from('annotation_tasks').select('trajectory_id,payload').eq('trajectory_id', id).single(),
    db.from('annotation_events').select('event_id,payload').eq('trajectory_id', id).order('round_id'),
  ]);
  if (taskError || eventError) return toast(errorText(taskError || eventError));
  state.current = {...task, events: (events || []).map(row => ({event_id: row.event_id, ...row.payload}))};
  const listRow = state.tasks.find(row => row.trajectory_id === id);
  state.review = listRow?.payload || {review_schema: 'strict_event_review_v2', reviews: state.current.events.map(event => ({event_id:event.event_id, decision:'', reason:'', notes:''})), notes:''};
  for (const event of state.current.events) if (!state.review.reviews.some(r => r.event_id === event.event_id)) state.review.reviews.push({event_id:event.event_id, decision:'', reason:'', notes:''});
  renderTasks(); renderTask();
}
function roundByItem(payload) { const result = {}; for (const round of payload.rounds || []) { result[round.incoming?.item_id] = round; result[round.target_response?.item_id] = round; } return result; }
function eventReview(eventId) { return state.review.reviews.find(row => row.event_id === eventId); }
function renderTask() {
  const trajectory = state.current.payload, lookup = roundByItem(trajectory);
  const conversation = (trajectory.rounds || []).map(round => `<article class="round"><div class="round-label">第 ${round.round_id} 轮</div><div class="utterance incoming"><span>${esc(round.incoming?.speaker || '对方')}</span><p>${esc(round.incoming?.text || '')}</p></div><div class="utterance target"><span>${esc(round.target_response?.speaker || trajectory.target_character || '目标角色')}</span><p>${esc(round.target_response?.text || '')}</p></div></article>`).join('');
  const cards = state.current.events.map(event => { const review = eventReview(event.event_id); const prior = (event.prior_evidence || []).map(id => lookup[id]?.round_id ? `第${lookup[id].round_id}轮` : id).join('、') || '—'; const after = (event.after_evidence || event.evidence || []).map(id => lookup[id]?.round_id ? `第${lookup[id].round_id}轮` : id).join('、') || '—'; return `<section class="review-card"><div class="review-meta"><b>${esc(dimensions[event.dimension] || event.dimension)}</b><span>${esc(event.object)}</span><span>第 ${event.round_id} 轮</span></div><h3>${esc(event.prior)} → ${esc(event.after)}</h3><p class="rationale">${esc(event.evaluation_question || event.rationale || '')}</p><p class="evidence-line">前态证据：${esc(prior)}　后态证据：${esc(after)}</p><label>复核决定<select data-decision="${esc(event.event_id)}"><option value="">请选择</option>${Object.entries(decisions).map(([key,label]) => `<option value="${key}" ${review.decision===key?'selected':''}>${label}</option>`).join('')}</select></label><label class="reason-field ${['ambiguous','exclude'].includes(review.decision)?'':'hidden'}" data-reason="${esc(event.event_id)}">原因<select data-reason-input="${esc(event.event_id)}"><option value="">请选择</option>${Object.entries(reasons).map(([key,label]) => `<option value="${key}" ${review.reason===key?'selected':''}>${label}</option>`).join('')}</select></label><label>备注（可选）<textarea data-notes="${esc(event.event_id)}" rows="2" placeholder="如需修改，请说明应如何调整。">${esc(review.notes)}</textarea></label></section>`; }).join('');
  $('#mainPanel').innerHTML = `<div class="task-page"><div class="task-heading"><p class="eyebrow">${esc(trajectory.source?.dataset || '')}</p><h1>${esc(trajectory.target_character || '')}</h1><p>${esc(state.current.trajectory_id)}</p></div><div class="review-grid"><section class="conversation"><h2>完整对话</h2>${conversation}</section><section class="review-pane"><h2>模型候选（${state.current.events.length}）</h2>${cards}<label>整体备注<textarea id="taskNotes" rows="3">${esc(state.review.notes || '')}</textarea></label><div class="form-actions"><button id="saveDraft" class="ghost">保存草稿</button><button id="submitReview" class="primary">提交本任务</button></div></section></div></div>`;
  document.querySelectorAll('[data-decision]').forEach(el => el.onchange = () => { eventReview(el.dataset.decision).decision = el.value; renderTask(); });
  document.querySelectorAll('[data-reason-input]').forEach(el => el.onchange = () => { eventReview(el.dataset.reasonInput).reason = el.value; });
  document.querySelectorAll('[data-notes]').forEach(el => el.oninput = () => { eventReview(el.dataset.notes).notes = el.value; });
  $('#saveDraft').onclick = () => saveReview('draft'); $('#submitReview').onclick = () => saveReview('submitted');
}
async function saveReview(status) {
  state.review.notes = $('#taskNotes').value;
  if (status === 'submitted') { const incomplete = state.review.reviews.some(row => !decisions[row.decision] || (['ambiguous','exclude'].includes(row.decision) && !row.reason)); if (incomplete) return toast('提交前请处理每条候选；存疑或排除必须选择原因。'); }
  const listRow = state.tasks.find(row => row.trajectory_id === state.current.trajectory_id);
  const payload = {user_id: state.user.id, trajectory_id: state.current.trajectory_id, status, revision: (listRow?.revision || 0) + 1, payload: state.review, updated_at: new Date().toISOString()};
  const {error} = await db.from('annotation_reviews').upsert(payload, {onConflict: 'user_id,trajectory_id'});
  if (error) return toast(errorText(error));
  toast(status === 'submitted' ? '已提交复核。' : '草稿已保存。'); await loadTasks();
}
bootstrap();

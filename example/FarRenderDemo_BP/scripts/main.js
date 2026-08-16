// FarRender リファレンス実装 (碧臨重工 / AORIN)
// プレイヤーごとに対象エンティティのゴーストを係留し、相対座標をプロパティ同期する
import { world, system } from "@minecraft/server";

const TARGETS = { "fdr:demo": "fdr:ghost_demo" }; // 本物のID → ゴーストのID
const FAMILY = "fdr_ghost";
const OWNER_TAG = "fdr_owner_";
const CAR_TAG = "fdr_target_";
const RANGE = 450;        // 追跡する最大距離
const RESCAN_TICKS = 8;   // 全走査の間隔(毎tickやると重い)

const propCache = new Map();
const scanCache = new Map();

// 差分書き込み(値が変わった時だけsetPropertyする。重要な軽量化)
function setP(r, key, val) {
  let m = propCache.get(r.id);
  if (!m) { m = {}; propCache.set(r.id, m); }
  if (m[key] === val) return;
  m[key] = val;
  r.setProperty(key, val);
}

function sync(ghost, target, player) {
  const pp = player.location;
  let base = ghost.location;
  // プレイヤーが24ブロック以上離れたら作り直して足元へ置き直す
  // ※「新しく出してから古いのを消す」順番。逆にすると一瞬消えて見える
  const dx = base.x - pp.x, dy = base.y - pp.y, dz = base.z - pp.z;
  if (dx * dx + dy * dy + dz * dz > 576) {
    const oTag = ghost.getTags().find((t) => t.startsWith(OWNER_TAG));
    const cTag = ghost.getTags().find((t) => t.startsWith(CAR_TAG));
    const old = ghost;
    ghost = player.dimension.spawnEntity(ghost.typeId, pp);
    if (oTag) ghost.addTag(oTag);
    if (cTag) ghost.addTag(cTag);
    propCache.delete(old.id);
    old.remove();
    base = pp;
  }
  setP(ghost, "fdr:px", Math.round((pp.x - base.x) * 10) / 10);
  setP(ghost, "fdr:pz", Math.round((pp.z - base.z) * 10) / 10);
  const loc = target.location;
  setP(ghost, "fdr:tx", loc.x - base.x);
  setP(ghost, "fdr:ty", loc.y - base.y);
  setP(ghost, "fdr:tz", loc.z - base.z);
  setP(ghost, "fdr:yaw", target.getRotation().y);
  setP(ghost, "fdr:active", true);
  return ghost;
}

// プレイヤー1人分の全走査: 対象を探し、ゴーストと対応付け、余りを掃除
function rescan(player) {
  const dim = player.dimension;
  const wanted = new Map();
  for (const e of dim.getEntities({ location: player.location, maxDistance: RANGE })) {
    if (TARGETS[e.typeId]) wanted.set(e.id, e);
  }
  const pairs = [];
  const seen = new Set();
  for (const g of dim.getEntities({ families: [FAMILY], tags: [OWNER_TAG + player.name] })) {
    const cTag = g.getTags().find((t) => t.startsWith(CAR_TAG));
    const id = cTag ? cTag.slice(CAR_TAG.length) : undefined;
    const target = id ? wanted.get(id) : undefined;
    if (!target || seen.has(id)) { propCache.delete(g.id); try { g.remove(); } catch (e) {} continue; }
    seen.add(id);
    pairs.push({ target, ghost: g });
  }
  for (const [id, target] of wanted) {
    if (seen.has(id)) continue;
    try {
      const g = dim.spawnEntity(TARGETS[target.typeId], player.location);
      g.addTag(OWNER_TAG + player.name);
      g.addTag(CAR_TAG + id);
      pairs.push({ target, ghost: g });
    } catch (e) {}
  }
  return pairs;
}

let tickNo = 0;
system.runInterval(() => {
  tickNo++;
  for (const player of world.getAllPlayers()) {
    let c = scanCache.get(player.name);
    if (!c || c.dirty || tickNo - c.tick >= RESCAN_TICKS) {
      c = { tick: tickNo, pairs: rescan(player), dirty: false };
      scanCache.set(player.name, c);
    }
    for (const pair of c.pairs) {
      try { pair.ghost = sync(pair.ghost, pair.target, player); }
      catch (e) { c.dirty = true; }
    }
  }
}, 1);

// ログアウトした人のゴースト掃除(5秒ごと)
system.runInterval(() => {
  const online = new Set();
  for (const p of world.getAllPlayers()) online.add(OWNER_TAG + p.name);
  for (const name of scanCache.keys()) {
    if (!online.has(OWNER_TAG + name)) scanCache.delete(name);
  }
  for (const g of world.getDimension("overworld").getEntities({ families: [FAMILY] })) {
    const t = g.getTags().find((x) => x.startsWith(OWNER_TAG));
    if (!t || !online.has(t)) g.remove();
  }
}, 100);

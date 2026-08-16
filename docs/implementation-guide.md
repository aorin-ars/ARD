# エンティティ描画距離突破 実装ガイド（クリエイター向け）

自分のアドオンのモブ・乗り物・建造物エンティティを、**64ブロックの描画限界を超えて遠くから見えるようにする**ための実装解説です。アドオン制作の経験（BP/RPの構成、Molangの基礎、スクリプトAPIの基礎）がある人向けです。

技術開発: 碧臨重工（AORIN）

---

## 1. 原理

統合版はエンティティを約64〜73ブロック（端末により差あり）でカリング（描画打ち切り）します。これはエンティティ「本体の位置」で判定されるため、モデルだけを遠くに描く分には制限がありません。そこで：

> **プレイヤーの近くに透明な「ゴーストエンティティ」を置き、
> モデルを Molang で本物の位置まで平行移動して描画する。**

- ゴースト本体はプレイヤーの足元付近にいる → カリングされない
- サーバー側スクリプトが毎tick「本物の座標 − ゴーストの座標」を計算し、**client_sync な actor property** に書き込む
- RP側のアニメーションがそのプロパティを読んで、ルートボーンを本物の位置まで動かす
- 近距離（〜64ブロック）は本物をそのまま見せ、それより遠くだけゴーストを表示 → 自動で切り替わって見える

必要なものは4つ。①ゴーストのBPエンティティ定義 ②ラップしたジオメトリ複製 ③ワールドアニメーション ④追従スクリプト。実験的機能のONは不要です（安定版スクリプトAPIのみ使用）。

---

## 2. ゴーストのBPエンティティ

`BP/entities/ghost_mymob.json` を作ります。ポイントは client_sync プロパティ群と、当たり判定・重力なしの「無害な置物」にすることです。

```json
{
  "format_version": "1.19.80",
  "minecraft:entity": {
    "description": {
      "identifier": "yourns:ghost_mymob",
      "is_spawnable": false,
      "is_summonable": true,
      "properties": {
        "fdr:active": { "type": "bool",  "default": false, "client_sync": true },
        "fdr:tx":  { "type": "float", "range": [-1000.0, 1000.0], "default": 0.0, "client_sync": true },
        "fdr:ty":  { "type": "float", "range": [-1000.0, 1000.0], "default": 0.0, "client_sync": true },
        "fdr:tz":  { "type": "float", "range": [-1000.0, 1000.0], "default": 0.0, "client_sync": true },
        "fdr:yaw": { "type": "float", "range": [-360.0, 360.0],   "default": 0.0, "client_sync": true },
        "fdr:px":  { "type": "float", "range": [-64.0, 64.0],     "default": 0.0, "client_sync": true },
        "fdr:pz":  { "type": "float", "range": [-64.0, 64.0],     "default": 0.0, "client_sync": true },
        "fdr:cut": { "type": "float", "range": [10.0, 200.0],     "default": 64.0, "client_sync": true }
      }
    },
    "components": {
      "minecraft:physics": { "has_gravity": false, "has_collision": false },
      "minecraft:collision_box": { "width": 0.1, "height": 0.1 },
      "minecraft:pushable": { "is_pushable": false, "is_pushable_by_piston": false },
      "minecraft:damage_sensor": { "triggers": [{ "cause": "all", "deals_damage": false }] },
      "minecraft:fire_immune": {},
      "minecraft:knockback_resistance": { "value": 1.0 },
      "minecraft:persistent": {},
      "minecraft:type_family": { "family": ["fdr_ghost", "inanimate"] }
    }
  }
}
```

プロパティの意味:

| プロパティ | 内容 |
|---|---|
| tx / ty / tz | 本物の座標 −ゴーストの座標（相対オフセット） |
| yaw | 本物の向き |
| px / pz | プレイヤーの座標 − ゴーストの座標（表示切替の距離計算用） |
| cut | 本物→ゴーストの切替距離（既定64） |
| active | 同期が始まるまで非表示にするためのフラグ |

**floatのdefaultやrangeは必ず `64.0` のように小数点付きで書くこと。** `64` と書くと型不一致で全プロパティのロードに失敗し、ゴーストが永遠に透明のままになります（コンテンツログに "Error loading Actor Properties" が出ます）。

---

## 3. ジオメトリのラップ

元のモデルをコピーして、identifier を変え、**移動用・回転用の2つのボーンを最上位に挿入**します。

```json
"bones": [
  { "name": "proto_root", "pivot": [0, 0, 0] },
  { "name": "proto_yaw", "pivot": [0, 0, 0], "parent": "proto_root" },
  ...元のボーン（parentを持たない最上位ボーン全部に "parent": "proto_yaw" を追加）...
]
```

- 元のボーン構造・キューブは一切変更しない。親のないボーンに `"parent": "proto_yaw"` を足すだけ
- **移動（proto_root）と回転（proto_yaw）は必ず別ボーンにする。** 同じボーンに入れると、回転した状態で移動した時にモデルが崩壊します

## 4. ワールドアニメーション

`RP/animations/fdr_world.animation.json`。プロパティを読んでルートボーンを動かす、この仕組みの心臓部です。

```json
{
  "format_version": "1.8.0",
  "animations": {
    "animation.fdr.world": {
      "loop": true,
      "bones": {
        "proto_root": {
          "position": [
            "query.property('fdr:tx') * 16",
            "query.property('fdr:ty') * 16",
            "-query.property('fdr:tz') * 16"
          ]
        },
        "proto_yaw": {
          "rotation": [0, "query.property('fdr:yaw')", 0]
        }
      }
    }
  }
}
```

**符号と単位はこの通りに。** 実測で確定している仕様です：

- ボーンpositionの単位は 1/16ブロック → `× 16`
- **Z軸だけ符号反転**（`-tz`）。X・Yはそのまま
- Y回転は `+yaw` そのまま
- クライアント側の `query.position` は当てにならないので使わない（オフセットは必ずサーバー計算で渡す）

## 5. クライアントエンティティ（ゴーストの見た目）

元のクライアントエンティティをコピーして作ります。変更点は4つ。

```json
{
  "format_version": "1.10.0",
  "minecraft:client_entity": {
    "description": {
      "identifier": "yourns:ghost_mymob",
      "materials": { "default": "phantom" },
      "textures": { "default": "textures/entity/mymob" },
      "geometry": { "default": "geometry.ghost_mymob" },
      "animations": {
        "world": "animation.fdr.world",
        "（元のアニメがあればそのまま列挙）": "..."
      },
      "scripts": { "animate": ["world"] },
      "render_controllers": ["controller.render.fdr_ghost"]
    }
  }
}
```

1. geometry → ラップした複製を指す
2. animations に `world` を追加し、`scripts.animate` で常時実行
3. materials の default を **phantom** に（本物が近くにいる瞬間の二重描画を目立たなくする）
4. render_controller を「遠距離のときだけ表示」のゲート付きにする：

```json
{
  "format_version": "1.10.0",
  "render_controllers": {
    "controller.render.fdr_ghost": {
      "geometry": "Geometry.default",
      "materials": [{ "*": "Material.default" }],
      "textures": ["Texture.default"],
      "part_visibility": [{
        "*": "query.property('fdr:active') && ((((query.property('fdr:tx') - query.property('fdr:px')) * (query.property('fdr:tx') - query.property('fdr:px'))) + ((query.property('fdr:tz') - query.property('fdr:pz')) * (query.property('fdr:tz') - query.property('fdr:pz')))) > (query.property('fdr:cut') * query.property('fdr:cut')))"
      }]
    }
  }
}
```

この式は「本物とプレイヤーの水平距離 > cut」の意味です（tx−px＝本物−プレイヤー）。これで近距離では本物だけ、遠距離ではゴーストだけが見えます。

## 6. 追従スクリプト

`BP/scripts/main.js`。プレイヤーごとに対象を探してゴーストを付け、毎tickオフセットを書き込みます。

```js
import { world, system } from "@minecraft/server";

// 本物のID → ゴーストのID
const TARGETS = { "yourns:mymob": "yourns:ghost_mymob" };
const FAMILY = "fdr_ghost";
const OWNER_TAG = "fdr_owner_";   // どのプレイヤー用か
const CAR_TAG = "fdr_target_";    // どの本物用か
const RANGE = 450;                // 追跡する最大距離
const RESCAN_TICKS = 8;           // 全走査の間隔（毎tickやると重い）

const propCache = new Map();
const scanCache = new Map();

// 差分書き込み（値が変わった時だけsetPropertyする。重要な軽量化）
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
  // プレイヤーが24ブロック以上離れたら作り直して足元に置き直す
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

// ログアウトした人のゴースト掃除（5秒ごと）
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
```

manifestにスクリプトモジュールを追加します：

```json
"modules": [
  { "type": "script", "language": "javascript", "uuid": "（新規UUID）",
    "version": [1, 0, 0], "entry": "scripts/main.js" }
],
"dependencies": [
  { "module_name": "@minecraft/server", "version": "1.15.0" }
]
```

---

## 7. 状態の同期（ドア・ライト・variantなど）

位置と向きだけならここまでで完成です。開くドアや点くライトのような「状態」も遠くで再現したい場合：

- **自作アドオンなら一番シンプル**: 状態を最初から client_sync の actor property で管理していれば、ゴーストに**同じ名前のプロパティ**を定義して、スクリプトで `ghost.setProperty(名前, 本物.getProperty(名前))` とコピーするだけ。RP側のアニメ・RCは書き換え不要でそのまま動きます
- `query.variant` / `query.mark_variant` / `query.skin_id` を使っている場合: ゴーストにはコンポーネントの値が引き継がれないので、`fdr:variant` のようなプロパティを追加してスクリプトでコピーし、ゴースト用アニメ複製内の `q.variant` を `q.property('fdr:variant')` に置換します
- **上限に注意**: actor property は1エンティティ32個まで。状態が多い場合は、複数の小さい値を掛け算で1つのfloatに詰め、Molang側で `math.mod(math.floor(q.property('x') / 桁), レンジ)` と取り出すテクニックで節約できます（floatが正確に表せるのは2^24までなので、詰め込む値の積が2^24以下になる範囲で）

同期**できない**もの: `query.modified_distance_moved`（歩行・車輪の回転）や `query.ground_speed` など、エンティティ自身の移動量から計算される値。ゴーストはその場に留まっているので0のままです。遠距離では実質見えないので、割り切ってください。

---

## 8. ハマりどころ集（実測で判明した仕様）

1. **Zだけ符号反転、回転は+yaw、単位は×16** — §4の式のまま使うこと
2. **移動と回転は別ボーン** — 同一ボーンだとカーブ・旋回で崩壊
3. **q.position は信用しない** — オフセットは必ずサーバーで計算してプロパティで渡す
4. **floatプロパティのJSONは小数点必須**（`64` ではなく `64.0`）— 特にツールで自動生成する場合、json出力が `.0` を落とさないか確認
5. **作り直しは「出してから消す」** — 逆順だと切替時に一瞬消える
6. **materialはphantom系** — 本物とゴーストが重なる切替距離ぎわの二重描画対策
7. **他のアドオンの dynamic property は読めない** — パックをまたいで状態を渡したい場合はスコアボードか /scriptevent を使う
8. **カリング距離は端末で違う**（実測64〜73）— 切替距離を64より上げすぎると、本物が消えてゴーストも出ない「隙間」ができる端末がある
9. 重い時は: 全走査の間隔を空ける（本ガイドは8tick）、setPropertyは差分書き込み、非表示中のアニメは `"animate": [{"anim": "表示条件式"}]` の条件付きにして評価をスキップ
10. 遠距離でモデルの面がチカチカする場合（Zファイティング）: 深度精度は距離の2乗で悪化するため近距離では起きない干渉が起きます。内側の面を消した遠距離用モデルにするか、ゴースト全体を1.5%ほど拡大すると解消します

## 9. 動作確認

1. ワールドに対象エンティティを置き、100〜200ブロック離れる → 見えれば成功
2. 見えない時はコンテンツログ（設定→クリエイター→コンテンツログ）を確認。プロパティ型エラー・Molangエラーが大体そこに出ます
3. 近づいたり離れたりして、切替距離での入れ替わりが自然かチェック
4. マルチでは2人以上で見え方を確認（ゴーストはプレイヤーごとに1体ずつ作られます）

---

このガイドの手法は碧臨重工（AORIN）が開発・検証したものです。
本手法を利用・紹介・解説する際は、クレジット表記が必須です（CC BY 4.0）:
「ARD (Aorin Render Distance) by 碧臨重工 / AORIN INDUSTRY — https://github.com/aorin-ars/ARD」

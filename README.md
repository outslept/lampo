# lampo

operation-based json crdt with causal map (add-wins), list (rga), and mv-register. zero dependencies.

## usage

```ts
import { cursorAt, JsonCrdtDocument } from "lampo";

const a = new JsonCrdtDocument("replica-a");
const b = new JsonCrdtDocument("replica-b");

const name = cursorAt(["user"], "name");

// concurrent edits
a.applyLocalAssign(name, "ada");
b.applyLocalAssign(name, "grace");

// sync deltas via state vectors
b.receiveWireBatch(a.exportDeltaSince(b.getStateVector()));
a.receiveWireBatch(b.exportDeltaSince(a.getStateVector()));

// mv-register keeps both concurrent values until causally overwritten
console.log(a.debugView());
// { user: { map: { name: { reg: ["ada", "grace"] } } } }

a.applyLocalAssign(name, "merged");
b.receiveWireBatch(a.exportDeltaSince(b.getStateVector()));
// { user: { map: { name: { reg: ["merged"] } } } }
```

## lists (rga)

```ts
import { cursorAt, JsonCrdtDocument, tsToString } from "lampo";

const doc = new JsonCrdtDocument("a");
const items = cursorAt([], "items");

doc.applyLocalAssignEmptyList(items);
const first = doc.applyLocalInsertListPrimitiveAtHead(items, "one");
doc.applyLocalInsertListPrimitiveAfter(items, tsToString(first.id), "two");
```

## snapshots & gc

```ts
const snap = doc.toSnapshot();
const restored = JsonCrdtDocument.fromSnapshot(snap, "replica-c");

// compact tombstones and prune op log up to a causally stable vector
const stable = { a: 10, b: 8 };
doc.compact(stable);
doc.pruneOpLog(stable);
```

## features

- **causal buffering** - out-of-order wire operations wait in a pending queue until their causal `deps` arrive.
- **add-wins maps & lists** - concurrent mutations survive key or element deletion.
- **mv-register** - preserves concurrent primitive writes on the same key and collapses them on the next causal write.
- **nested list elements** - list elements can hold primitives, nested maps, or inner lists.
- **snapshots & compaction** - state vector delta sync, full snapshots, and causal garbage collection.

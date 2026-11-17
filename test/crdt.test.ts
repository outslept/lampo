import { describe, expect, it, vi } from "vitest";
import {
  cmpTimestampStr,
  cursorAt,
  fromWire,
  JsonCrdtDocument,
  LamportClock,
  LIST_HEAD,
  toWire,
  tsFromString,
  tsToString,
} from "../src/index.js";

function sync(a: JsonCrdtDocument, b: JsonCrdtDocument): void {
  const aToB = a.exportDeltaSince(b.getStateVector());
  const bToA = b.exportDeltaSince(a.getStateVector());
  b.receiveWireBatch(aToB);
  a.receiveWireBatch(bToA);
}

describe("timestamp & LamportClock", () => {
  it("formats, parses, and orders timestamps", () => {
    const ts = tsFromString("10:replica-a");
    expect(ts).toEqual({ c: 10, p: "replica-a" });
    expect(tsToString(ts)).toBe("10:replica-a");

    expect(cmpTimestampStr("2:b", "10:a")).toBe(-1);
    expect(cmpTimestampStr("10:a", "10:b")).toBe(-1);
    expect(cmpTimestampStr("10:b", "10:a")).toBe(1);
    expect(cmpTimestampStr("10:a", "10:a")).toBe(0);

    expect(() => tsFromString("invalid")).toThrow();
    expect(() => tsFromString("NaN:a")).toThrow();
  });

  it("advances clock on tick and observe", () => {
    const clock = new LamportClock("r1", 5);
    expect(clock.tick()).toEqual({ c: 6, p: "r1" });
    clock.observe({ c: 20, p: "r2" });
    expect(clock.tick()).toEqual({ c: 21, p: "r1" });
  });
});

describe("Map & MV-Register", () => {
  it("resolves concurrent assignments into MV-Register and clears on causal overwrite", () => {
    const a = new JsonCrdtDocument("a");
    const b = new JsonCrdtDocument("b");
    const cur = cursorAt(["profile"], "name");

    a.applyLocalAssign(cur, "Alice");
    b.applyLocalAssign(cur, "Bob");
    sync(a, b);

    expect(a.debugView()).toEqual({
      profile: { map: { name: { reg: ["Alice", "Bob"] } } },
    });
    expect(b.debugView()).toEqual(a.debugView());

    a.applyLocalAssign(cur, "Merged");
    sync(a, b);

    expect(b.debugView()).toEqual({
      profile: { map: { name: { reg: ["Merged"] } } },
    });
  });

  it("implements add-wins semantics on concurrent delete and assign", () => {
    const a = new JsonCrdtDocument("a");
    const b = new JsonCrdtDocument("b");
    const cur = cursorAt([], "key");

    a.applyLocalAssign(cur, "v1");
    sync(a, b);

    a.applyLocalDeleteKey(cur);
    b.applyLocalAssign(cur, "v2");
    sync(a, b);

    expect(a.debugView()).toEqual({ key: { reg: ["v2"] } });
    expect(b.debugView()).toEqual(a.debugView());
  });
});

describe("List (RGA)", () => {
  it("converges on concurrent inserts and handles element deletion", () => {
    const a = new JsonCrdtDocument("a");
    const b = new JsonCrdtDocument("b");
    const listCur = cursorAt([], "items");

    a.applyLocalAssignEmptyList(listCur);
    const firstOp = a.applyLocalInsertListPrimitiveAtHead(listCur, "first");
    const firstId = tsToString(firstOp.id);
    sync(a, b);

    a.applyLocalInsertListPrimitiveAfter(listCur, firstId, "from-a");
    b.applyLocalInsertListPrimitiveAfter(listCur, firstId, "from-b");
    sync(a, b);

    expect(a.debugView()).toEqual(b.debugView());
    const id0 = a.listElementIdAt([], "items", 0)!;
    const id1 = a.listElementIdAt([], "items", 1)!;
    expect(a.listIndexOfElement([], "items", id0)).toBe(0);
    expect(a.listIndexOfElement([], "items", id1)).toBe(1);

    a.applyLocalDeleteListElement(listCur, firstId);
    sync(a, b);

    expect(b.listIndexOfElement([], "items", firstId)).toBeUndefined();
    expect(b.listElementIdAt([], "items", 0)).toBe(id1);
  });

  it("keeps list key alive when element is inserted concurrently with delete_key", () => {
    const a = new JsonCrdtDocument("a");
    const b = new JsonCrdtDocument("b");
    const listCur = cursorAt([], "items");

    a.applyLocalAssignEmptyList(listCur);
    sync(a, b);

    a.applyLocalDeleteKey(listCur);
    b.applyLocalInsertListPrimitiveAtHead(listCur, "kept");
    sync(a, b);

    expect(a.debugView().items?.list).toHaveLength(1);
    expect(a.debugView().items?.list?.[0]?.value).toEqual({ reg: ["kept"] });
  });
});

describe("Composite list elements (Map / inner List / Primitive)", () => {
  it("supports nested maps and inner lists inside list elements and clears across types", () => {
    const doc = new JsonCrdtDocument("a");
    const listCur = cursorAt([], "rows");

    doc.applyLocalAssignEmptyList(listCur);
    const ins = doc.applyLocalInsertListPrimitiveAtHead(listCur, "init");
    const elemId = tsToString(ins.id);

    doc.applyLocalAssignElemEmptyMap(listCur, elemId);
    doc.applyLocalAssignElemMapPrimitive(listCur, elemId, ["meta"], "tag", "v1");
    expect(doc.debugView().rows?.list?.[0]?.value).toEqual({
      reg: [],
      map: { meta: { map: { tag: { reg: ["v1"] } } } },
    });

    doc.applyLocalAssignElemEmptyList(listCur, elemId);
    const childIns = doc.applyLocalInsertElemListPrimitiveAtHead(listCur, elemId, 42);
    const childId = tsToString(childIns.id);
    expect(doc.debugView().rows?.list?.[0]?.value).toEqual({
      reg: [],
      map: {},
      list: [{ id: childId, value: { reg: [42] } }],
    });

    doc.applyLocalDeleteElemListElement(listCur, elemId, childId);
    expect(doc.debugView().rows?.list?.[0]?.value.list).toEqual([]);

    doc.applyLocalAssignElemMapPrimitive(listCur, elemId, [], "temp", true);
    doc.applyLocalAssignElemPrimitive(listCur, elemId, "plain");
    expect(doc.debugView().rows?.list?.[0]?.value).toEqual({
      reg: ["plain"],
      map: {},
      list: [],
    });
  });
});

describe("Causality & pending buffer", () => {
  it("buffers out-of-order operations and drains them once dependencies arrive", () => {
    const a = new JsonCrdtDocument("a");
    const b = new JsonCrdtDocument("b");
    const cur = cursorAt([], "x");

    const op1 = toWire(a.applyLocalAssign(cur, 1));
    const op2 = toWire(a.applyLocalAssign(cur, 2));

    b.receiveWire(op2);
    expect(b.getPendingCount()).toBe(1);
    expect(b.getPendingIds()).toEqual(["2:a"]);
    expect(b.debugView()).toEqual({});

    b.receiveWire(op1);
    expect(b.getPendingCount()).toBe(0);
    expect(b.debugView()).toEqual({ x: { reg: [2] } });
  });

  it("does not mark failed pending op as processed or unlock its dependents", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const doc = new JsonCrdtDocument("b");
    const cur = cursorAt([], "missingList");

    doc.receiveWire({
      version: 1,
      id: { c: 2, p: "a" },
      deps: ["1:a"],
      cursor: cur,
      mut: { kind: "insert_list_primitive", after: LIST_HEAD, value: "bad" },
    });
    doc.receiveWire({
      version: 1,
      id: { c: 3, p: "a" },
      deps: ["2:a"],
      cursor: cursorAt([], "afterBad"),
      mut: { kind: "assign_primitive", value: "should-stay-pending" },
    });

    doc.receiveWire({
      version: 1,
      id: { c: 1, p: "a" },
      deps: [],
      cursor: cursorAt([], "ok"),
      mut: { kind: "assign_primitive", value: "ok" },
    });

    expect(doc.getProcessedIds().has("2:a")).toBe(false);
    expect(doc.getPendingIds()).toEqual(["3:a"]);
    expect(doc.debugView()).toEqual({ ok: { reg: ["ok"] } });
    errSpy.mockRestore();
  });
});

describe("Wire roundtrip, Snapshots & Compaction", () => {
  it("restores full state from snapshot and continues generating valid ops", () => {
    const a = new JsonCrdtDocument("a");
    a.applyLocalAssign(cursorAt(["user"], "name"), "Ada");

    const snap = a.toSnapshot();
    const restored = JsonCrdtDocument.fromSnapshot(snap, "b");

    expect(restored.debugView()).toEqual(a.debugView());
    expect(restored.getStateVector()).toEqual({ a: 1 });

    restored.applyLocalAssign(cursorAt(["user"], "name"), "Grace");
    expect(restored.debugView()).toEqual({
      user: { map: { name: { reg: ["Grace"] } } },
    });
  });

  it("roundtrips all operation kinds through toWire/fromWire and compacts GC vector", () => {
    const doc = new JsonCrdtDocument("a");
    const cur = cursorAt([], "k");
    const op = doc.applyLocalAssign(cur, "v1");
    expect(fromWire(toWire(op))).toEqual(op);

    doc.applyLocalDeleteKey(cur);
    doc.compact({ a: 2 });
    doc.pruneOpLog({ a: 2 });

    expect(doc.debugView()).toEqual({});
    expect(doc.exportDeltaSince({})).toEqual([]);
  });
});

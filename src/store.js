const stringify = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

export class D1SagaStore {
  constructor(db) { this.db = db; }

  async create(record) {
    const now = record.createdAt;
    await this.db.prepare("INSERT INTO sagas (id, mode, state, owner, amount_raw, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(record.id, record.mode, record.state, record.owner, record.amountRaw, stringify(record), now, now).run();
    await this.log(record.id, record.state, "SAGA_CREATED", { mode: record.mode, amount: record.amount });
    return record;
  }

  async get(id) {
    const row = await this.db.prepare("SELECT record_json FROM sagas WHERE id = ?").bind(id).first();
    return row ? JSON.parse(row.record_json) : null;
  }

  async save(record) {
    record.updatedAt = new Date().toISOString();
    await this.db.prepare("UPDATE sagas SET state = ?, record_json = ?, updated_at = ? WHERE id = ?")
      .bind(record.state, stringify(record), record.updatedAt, record.id).run();
    return record;
  }

  async transition(record, state, event, details = {}) {
    record.state = state;
    record.timeline.push({ timestamp: new Date().toISOString(), state, event, details });
    await this.save(record);
    await this.log(record.id, state, event, details);
    return record;
  }

  async log(id, state, event, details) {
    await this.db.prepare("INSERT INTO saga_logs (saga_id, timestamp, state, event, details_json) VALUES (?, ?, ?, ?, ?)")
      .bind(id, new Date().toISOString(), state, event, stringify(details)).run();
  }

  async acquire(id, token) {
    const result = await this.db.prepare("UPDATE sagas SET executing = 1, lock_token = ? WHERE id = ? AND executing = 0")
      .bind(token, id).run();
    return result.meta.changes === 1;
  }

  async release(id, token) {
    await this.db.prepare("UPDATE sagas SET executing = 0, lock_token = NULL WHERE id = ? AND lock_token = ?").bind(id, token).run();
  }

  async list(limit = 20) {
    const result = await this.db.prepare("SELECT record_json FROM sagas ORDER BY updated_at DESC LIMIT ?").bind(limit).all();
    return result.results.map((row) => JSON.parse(row.record_json));
  }

  async consumeRateLimit(actor, now = Date.now(), windowMs = 3_600_000, limit = 6) {
    const row = await this.db.prepare("SELECT window_start, count FROM rate_limits WHERE actor = ?").bind(actor).first();
    if (!row || now - row.window_start >= windowMs) {
      await this.db.prepare("INSERT INTO rate_limits (actor, window_start, count) VALUES (?, ?, 1) ON CONFLICT(actor) DO UPDATE SET window_start = excluded.window_start, count = 1")
        .bind(actor, now).run();
      return true;
    }
    if (row.count >= limit) return false;
    await this.db.prepare("UPDATE rate_limits SET count = count + 1 WHERE actor = ?").bind(actor).run();
    return true;
  }
}

export class MemorySagaStore {
  constructor() { this.records = new Map(); this.locks = new Map(); this.logs = []; }
  async create(record) { this.records.set(record.id, structuredClone(record)); return record; }
  async get(id) { const r = this.records.get(id); return r ? structuredClone(r) : null; }
  async save(record) { this.records.set(record.id, structuredClone(record)); return record; }
  async transition(record, state, event, details = {}) { record.state = state; record.timeline.push({ timestamp: new Date().toISOString(), state, event, details }); this.logs.push({ id: record.id, state, event, details }); return this.save(record); }
  async log(id, state, event, details) { this.logs.push({ id, state, event, details }); }
  async acquire(id, token) { if (this.locks.has(id)) return false; this.locks.set(id, token); return true; }
  async release(id, token) { if (this.locks.get(id) === token) this.locks.delete(id); }
  async list() { return [...this.records.values()].map(structuredClone); }
}

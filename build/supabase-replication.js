import { RxReplicationState } from "rxdb/plugins/replication";
import { Subject } from "rxjs";
const DEFAULT_LAST_MODIFIED_FIELD = "_modified";
const DEFAULT_DELETED_FIELD = "_deleted";
const POSTGRES_DUPLICATE_KEY_ERROR_CODE = "23505";
class SupabaseReplication extends RxReplicationState {
  constructor(options) {
    const realtimeChanges = new Subject();
    super(
      options.replicationIdentifier,
      options.collection,
      options.deletedField || DEFAULT_DELETED_FIELD,
      options.pull && {
        ...options.pull,
        stream$: realtimeChanges,
        handler: (lastCheckpoint, batchSize) => this.pullHandler(lastCheckpoint, batchSize)
      },
      options.push && {
        ...options.push,
        batchSize: 1,
        // TODO: support batch insertion
        handler: (rows) => this.pushHandler(rows)
      },
      typeof options.live === "undefined" ? true : options.live,
      typeof options.retryTime === "undefined" ? 5e3 : options.retryTime,
      typeof options.autoStart === "undefined" ? true : options.autoStart
    );
    this.options = options;
    this.realtimeChanges = realtimeChanges;
    this.table = options.table || options.collection.name;
    this.primaryKey = options.primaryKey || options.collection.schema.primaryPath;
    this.lastModifiedFieldName = options.pull?.lastModifiedField || DEFAULT_LAST_MODIFIED_FIELD;
    if (this.autoStart) {
      void this.start();
    }
  }
  table;
  primaryKey;
  lastModifiedFieldName;
  realtimeChanges;
  realtimeChannel;
  async start() {
    if (this.live && this.options.pull && (this.options.pull.realtimePostgresChanges || typeof this.options.pull.realtimePostgresChanges === "undefined")) {
      this.watchPostgresChanges();
    }
    return super.start();
  }
  async cancel() {
    if (this.realtimeChannel) {
      return Promise.all([super.cancel(), this.realtimeChannel.unsubscribe()]);
    }
    return super.cancel();
  }
  /**
   * Pulls all changes since the last checkpoint from supabase.
   */
  async pullHandler(lastCheckpoint, batchSize) {
    let query = this.options.supabaseClient.from(this.table).select();
    if (lastCheckpoint && lastCheckpoint.modified) {
      const lastModified = JSON.stringify(lastCheckpoint.modified);
      const lastPrimaryKey = JSON.stringify(lastCheckpoint.primaryKeyValue);
      const isNewer = `${this.lastModifiedFieldName}.gt.${lastModified}`;
      const isSameAge = `${this.lastModifiedFieldName}.eq.${lastModified}`;
      query = query.or(`${isNewer},and(${isSameAge},${this.primaryKey}.gt.${lastPrimaryKey})`);
    }
    query = query.order(this.lastModifiedFieldName).order(this.primaryKey).limit(batchSize);
    const { data, error } = await query;
    if (error)
      throw error;
    if (data.length == 0) {
      return {
        checkpoint: lastCheckpoint,
        documents: []
      };
    } else {
      return {
        checkpoint: this.rowToCheckpoint(data[data.length - 1]),
        documents: data.map(this.rowToRxDoc.bind(this))
      };
    }
  }
  /**
   * Pushes local changes to supabase.
   */
  async pushHandler(rows) {
    if (rows.length != 1)
      throw new Error("Invalid batch size");
    const row = rows[0];
    return row.assumedMasterState ? this.handleUpdate(row) : this.handleInsertion(row.newDocumentState);
  }
  /**
   * Tries to insert a new row. Returns the current state of the row in case of a conflict.
   */
  async handleInsertion(doc) {
    const { error } = await this.options.supabaseClient.from(this.table).insert(doc);
    if (!error) {
      return [];
    } else if (error.code == POSTGRES_DUPLICATE_KEY_ERROR_CODE) {
      return [await this.fetchByPrimaryKey(doc[this.primaryKey])];
    } else {
      throw error;
    }
  }
  /**
   * Updates a row in supabase if all fields match the local state. Otherwise, the current
   * state is fetched and passed to the conflict handler.
   */
  async handleUpdate(row) {
    const updateHandler = this.options.push?.updateHandler || this.defaultUpdateHandler.bind(this);
    if (await updateHandler(row))
      return [];
    return [await this.fetchByPrimaryKey(row.newDocumentState[this.primaryKey])];
  }
  /**
   * Updates the row only if all database fields match the expected state.
   */
  async defaultUpdateHandler(row) {
    let query = this.options.supabaseClient.from(this.table).update(row.newDocumentState, { count: "exact" });
    Object.entries(row.assumedMasterState).forEach(([field, value]) => {
      const type = typeof value;
      if (type === "string" || type === "number") {
        query = query.eq(field, value);
      } else if (type === "boolean" || value === null) {
        query = query.is(field, value);
      } else {
        throw new Error(`replicateSupabase: Unsupported field of type ${type}`);
      }
    });
    const { error, count } = await query;
    if (error)
      throw error;
    return count == 1;
  }
  watchPostgresChanges() {
    this.realtimeChannel = this.options.supabaseClient.channel(`rxdb-supabase-${this.replicationIdentifier}`).on("postgres_changes", { event: "*", schema: "public", table: this.table }, (payload) => {
      if (payload.eventType === "DELETE" || !payload.new)
        return;
      this.realtimeChanges.next({
        checkpoint: this.rowToCheckpoint(payload.new),
        documents: [this.rowToRxDoc(payload.new)]
      });
    }).subscribe();
  }
  async fetchByPrimaryKey(primaryKeyValue) {
    const { data, error } = await this.options.supabaseClient.from(this.table).select().eq(this.primaryKey, primaryKeyValue).limit(1);
    if (error)
      throw error;
    if (data.length != 1)
      throw new Error("No row with given primary key");
    return this.rowToRxDoc(data[0]);
  }
  rowToRxDoc(row) {
    return row;
  }
  rowToCheckpoint(row) {
    return {
      modified: row[this.lastModifiedFieldName],
      primaryKeyValue: row[this.primaryKey]
    };
  }
}
export {
  SupabaseReplication
};
//# sourceMappingURL=supabase-replication.js.map

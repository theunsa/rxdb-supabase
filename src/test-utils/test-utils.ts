import { RxConflictHandler, RxConflictHandlerInput, RxError } from "rxdb"
import { RxReplicationState } from "rxdb/plugins/replication"
import { SupabaseReplication, SupabaseReplicationCheckpoint } from "../supabase-replication.js"
import { Human, HumanRow } from "./test-types.js"

/**
 * Starts a SupabaseReplication with the given factory, executes the given callback while the replication
 * is running, and then stops the replication again.
 *
 * Throws on any errors that happened within the replication code, unless expectErrors is set to true, in
 * which case all errors are returned.
 */
export async function withReplication(
  replicationFactory: () => SupabaseReplication<Human>,
  callback: (
    state: RxReplicationState<Human, SupabaseReplicationCheckpoint>
  ) => Promise<void> = async () => {},
  expectErrors = false
): Promise<Error[]> {
  return new Promise(async (resolve, reject) => {
    const errors: Error[] = []
    const replication = replicationFactory()
    replication.error$.subscribe((error: any) => {
      if (expectErrors) {
        errors.push(error)
      } else {
        console.error("Replication emitted an unexpected error:", error)
        reject(error.rxdb ? error.parameters.errors![0] : error)
      }
    })
    await replication.awaitInitialReplication()
    await callback(replication)
    await replication.awaitInSync()
    await replication.cancel()
    resolve(errors)
  })
}

/**
 * A simple conflict handler for tests
 */
export function resolveConflictWithName<T>(name: string): RxConflictHandler<T> {
  return async (input: RxConflictHandlerInput<T>) => {
    return {
      isEqual: false,
      documentData: { ...input.newDocumentState, name },
    }
  }
}

import process from "process"
import { SupabaseClient, createClient } from "@supabase/supabase-js"

import {
  createRxDatabase,
  RxCollection,
  RxConflictHandler,
  RxConflictHandlerInput,
  RxDatabase,
  WithDeleted,
  addRxPlugin,
} from "rxdb"
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode"
import { RxReplicationState } from "rxdb/plugins/replication"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import { lastValueFrom, take } from "rxjs"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  SupabaseReplication,
  SupabaseReplicationCheckpoint,
  SupabaseReplicationOptions,
} from "../supabase-replication.js"
import { Human, HUMAN_SCHEMA } from "../test-utils/test-types.js"
import { withReplication } from "../test-utils/test-utils.js"

/**
 * Integration test running against an actual Supabase instance.
 *
 * This test will only run if the TEST_SUPABASE_URL and TEST_SUPABASE_API_KEY environment
 * variables are present. It requires a "humans" table to be created, see humans.sql for
 * the table structure.
 */
describe.skipIf(!process.env.INTEGRATION_TEST)(
  "replicateSupabase with actual SupabaseClient",
  () => {
    let supabase: SupabaseClient
    let db: RxDatabase
    let collection: RxCollection<Human>

    beforeAll(() => {
      supabase = createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_API_KEY!, {
        auth: { persistSession: false },
      })
      addRxPlugin(RxDBDevModePlugin)
    })

    beforeEach(async () => {
      // Empty the supabase table.
      const { error } = await supabase.from("humans").delete().neq("id", -1)
      if (error) throw error

      // Create an in-memory RxDB database.
      db = await createRxDatabase({
        name: "test",
        storage: getRxStorageMemory(),
      })
      collection = (
        await db.addCollections({
          humans: { schema: HUMAN_SCHEMA },
        })
      ).humans

      // Start with Alice :)
      await replication({}, async () => {
        // TODO: remove explicit null, should be set by pull anyways
        await collection.insert({ id: "1", name: "Alice", age: null })
      })
      expect(await rxdbContents()).toEqual([{ id: "1", name: "Alice", age: null }])
      expect(await supabaseContents()).toEqual([
        { id: "1", name: "Alice", age: null, _deleted: false },
      ])
    })

    describe("on client-side insertion", () => {
      describe("without conflict", () => {
        it("inserts into supabase", async () => {
          await replication({}, async () => {
            await collection.insert({ id: "2", name: "Bob", age: null })
          })

          expect(await supabaseContents()).toEqual([
            { id: "1", name: "Alice", age: null, _deleted: false },
            { id: "2", name: "Bob", age: null, _deleted: false },
          ])
        })
      })

      describe("with conflict", () => {
        describe("with default conflict handler", () => {
          it("drops insertion", async () => {
            await supabase.from("humans").insert({ id: "2", name: "Bob" })
            await collection.insert({ id: "2", name: "Bob 2", age: 2 })
            await replication()

            expect(await supabaseContents()).toEqual([
              { id: "1", name: "Alice", age: null, _deleted: false },
              { id: "2", name: "Bob", age: null, _deleted: false },
            ])
            expect(await rxdbContents()).toEqual([
              { id: "1", name: "Alice", age: null },
              { id: "2", name: "Bob", age: null },
            ])
          })
        })

        describe("with custom conflict handler", () => {
          it("invokes conflict handler", async () => {
            collection.conflictHandler = resolveConflictWithName("Bob resolved")

            await supabase.from("humans").insert({ id: "2", name: "Bob remote" })
            await collection.insert({ id: "2", name: "Bob local", age: 42 })
            await replication()

            expect(await supabaseContents()).toEqual([
              { id: "1", name: "Alice", age: null, _deleted: false },
              { id: "2", name: "Bob resolved", age: 42, _deleted: false },
            ])
            expect(await rxdbContents()).toEqual([
              { id: "1", name: "Alice", age: null },
              { id: "2", name: "Bob resolved", age: 42 },
            ])
          })
        })
      })
    })

    describe("on client-side update", () => {
      describe("without conflict", () => {
        it("updates supabase", async () => {
          await replication({}, async () => {
            const doc = await collection.findOne("1").exec()
            await doc!.patch({ age: 42 })
          })
          expect(await supabaseContents()).toEqual([
            { id: "1", name: "Alice", age: 42, _deleted: false },
          ])
        })

        describe("with postgREST special characters", () => {
          it("updates supabase", async () => {
            // Prepare database with rows that contain special characters.
            await collection.insert({
              id: "special-,.()-id",
              name: 'Robert "Bob" Doe',
              age: null,
            })
            await replication()
            expect(await supabaseContents()).toEqual([
              { id: "1", name: "Alice", age: null, _deleted: false },
              {
                id: "special-,.()-id",
                name: 'Robert "Bob" Doe',
                age: null,
                _deleted: false,
              },
            ])
            const doc = await collection.findOne("special-,.()-id").exec()

            // The UPDATE query will now contain the special characters in the URL params.
            await doc!.patch({ age: 42 })
            await replication()

            expect(await rxdbContents()).toEqual([
              { id: "1", name: "Alice", age: null },
              { id: "special-,.()-id", name: 'Robert "Bob" Doe', age: 42 },
            ])
            expect(await supabaseContents()).toEqual([
              { id: "1", name: "Alice", age: null, _deleted: false },
              {
                id: "special-,.()-id",
                name: 'Robert "Bob" Doe',
                age: 42,
                _deleted: false,
              },
            ])
          })
        })
      })

      describe("with conflict", () => {
        beforeEach(async () => {
          // Set Alice's age to 42 locally, while changing her name on the server.
          const doc = await collection.findOne("1").exec()
          await doc!.patch({ age: 42 })
          await supabase.from("humans").update({ name: "Alex" }).eq("id", "1")
        })

        describe("with default conflict handler", () => {
          it("applies supabase changes", async () => {
            await replication()
            expect(await rxdbContents()).toEqual([{ id: "1", name: "Alex", age: null }])
            expect(await supabaseContents()).toEqual([
              { id: "1", name: "Alex", age: null, _deleted: false },
            ])
          })
        })

        describe("with custom conflict handler", () => {
          it("invokes conflict handler", async () => {
            collection.conflictHandler = resolveConflictWithName("Conflict resolved")
            await replication()
            expect(await rxdbContents()).toEqual([{ id: "1", name: "Conflict resolved", age: 42 }])
            expect(await supabaseContents()).toEqual([
              { id: "1", name: "Conflict resolved", age: 42, _deleted: false },
            ])
          })
        })
      })
    })

    describe("when supabase changed while offline", () => {
      it("pulls new rows", async () => {
        await supabase.from("humans").insert({ id: "2", name: "Bob", age: 42 })
        await replication()

        expect(await rxdbContents()).toEqual([
          { id: "1", name: "Alice", age: null },
          { id: "2", name: "Bob", age: 42 },
        ])
      })

      it("pulls rows in multiple batches", async () => {
        // In this test, we set the batchSize to 1, but insert multiple rows into supabase such that
        // they have the same _modified timestamp. The test will only pass if the pull query fetches
        // rows with the same timestamp as the last checkpoint (but higher primary key).
        await supabase.from("humans").insert([
          { id: "2", name: "Human 2" },
          { id: "3", name: "Human 3" },
        ])
        await replication({ pull: { batchSize: 1 } })

        expect(await rxdbContents()).toHaveLength(3)
      })

      it("pulls updated rows", async () => {
        await supabase.from("humans").update({ age: 42 }).eq("id", "1")
        await replication()

        expect(await rxdbContents()).toEqual([{ id: "1", name: "Alice", age: 42 }])
      })

      it("removes rows marked as deleted", async () => {
        await supabase.from("humans").update({ _deleted: true }).eq("id", "1")
        await replication()

        expect(await rxdbContents()).toEqual([])
      })

      it("ignores actually deleted rows", async () => {
        await supabase.from("humans").delete().eq("id", "1")
        await replication()

        expect(await rxdbContents()).toEqual([{ id: "1", name: "Alice", age: null }])
      })
    })

    describe("when supabase changed while online", () => {
      describe("without realtime replication", () => {
        it("does not pull new rows", async () => {
          await replication({}, async () => {
            await supabase.from("humans").insert({ id: "2", name: "Bob", age: 42 })
            await new Promise((resolve) => setTimeout(() => resolve(true), 1000)) // Wait for some time
          })

          expect(await rxdbContents()).toEqual([{ id: "1", name: "Alice", age: null }])
        })
      })

      describe("with realtime replication", () => {
        it("pulls new rows", async () => {
          await replication({ pull: { realtimePostgresChanges: true } }, async (replication) => {
            await supabase.from("humans").insert({ id: "2", name: "Bob", age: 42 })
            await lastValueFrom(replication.remoteEvents$.pipe(take(1))) // Wait for remote event
          })

          expect(await rxdbContents()).toEqual([
            { id: "1", name: "Alice", age: null },
            { id: "2", name: "Bob", age: 42 },
          ])
        })

        it("pulls updated rows", async () => {
          await replication({ pull: { realtimePostgresChanges: true } }, async (replication) => {
            await supabase.from("humans").update({ age: 42 }).eq("id", "1")
            await lastValueFrom(replication.remoteEvents$.pipe(take(1))) // Wait for remote event
          })

          expect(await rxdbContents()).toEqual([{ id: "1", name: "Alice", age: 42 }])
        })

        it("removes rows marked as deleted", async () => {
          await replication({ pull: { realtimePostgresChanges: true } }, async (replication) => {
            await supabase.from("humans").update({ _deleted: true }).eq("id", "1")
            await lastValueFrom(replication.remoteEvents$.pipe(take(1))) // Wait for remote event
          })

          expect(await rxdbContents()).toEqual([])
        })

        it("ignores actually deleted rows", async () => {
          await replication({ pull: { realtimePostgresChanges: true } }, async (replication) => {
            await supabase.from("humans").delete().eq("id", "1")
            await new Promise((resolve) => setTimeout(() => resolve(true), 1000)) // Wait for some time
          })

          expect(await rxdbContents()).toEqual([{ id: "1", name: "Alice", age: null }])
        })
      })
    })

    const replication = (
      options: Partial<SupabaseReplicationOptions<Human>> = {},
      callback: (
        state: RxReplicationState<Human, SupabaseReplicationCheckpoint>
      ) => Promise<void> = async () => {},
      expectErrors = false
    ): Promise<Error[]> => {
      return withReplication(() => startReplication(options), callback, expectErrors)
    }

    const startReplication = (
      options: Partial<SupabaseReplicationOptions<Human>> = {}
    ): SupabaseReplication<Human> => {
      const status = new SupabaseReplication({
        replicationIdentifier: "test",
        supabaseClient: supabase,
        collection,
        pull: { realtimePostgresChanges: false },
        push: {},
        ...options,
      })
      return status
    }

    const resolveConflictWithName = <T>(name: string): RxConflictHandler<T> => {
      return async (input: RxConflictHandlerInput<T>) => {
        return {
          isEqual: false,
          documentData: { ...input.newDocumentState, name },
        }
      }
    }

    const supabaseContents = async (stripModified = true): Promise<WithDeleted<Human>[]> => {
      const { data, error } = await supabase.from("humans").select().order("id")
      if (error) throw error
      if (stripModified) data.forEach((human) => delete human._modified)
      return data as WithDeleted<Human>[]
    }

    const rxdbContents = async (): Promise<Human[]> => {
      const results = await collection.find().exec()
      return results.map((doc) => doc.toJSON())
    }

    afterEach(async () => {
      await db.remove()
    })
  }
)

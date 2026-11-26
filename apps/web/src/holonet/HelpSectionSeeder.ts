/*
Copyright 2026 Holonet contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import { type MatrixClient, type Room, RoomEvent } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import SdkConfig from "../SdkConfig";
import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import {
    CUSTOM_SECTION_TAG_PREFIX,
    getCustomSectionData,
    getOrderedReorderableSections,
} from "../stores/room-list-v3/section";
import { MetaSpace } from "../stores/spaces";
import { getSectionTagForRoom } from "../utils/room/getSectionTagForRoom";
import { tagRoom } from "../utils/room/tagRoom";

/** The fixed tag of the Help section, so every account gets the same section id. */
export const HELP_SECTION_TAG = `${CUSTOM_SECTION_TAG_PREFIX}holonet.help` as const;

/** Account data event remembering what has already been seeded for this account. */
export const HELP_SECTION_STATE_EVENT = "cloud.trevors.holonet.help_section";

/**
 * What has already been done for this account. Anything recorded here is never done again, so a
 * member who deletes the section or moves a room out of it keeps that choice.
 */
export interface HelpSectionState {
    /** True once the section has been created for this account. */
    section_created?: boolean;
    /** Rooms already offered to the section, whether or not they were added. */
    seeded_rooms?: string[];
}

declare module "matrix-js-sdk/src/types" {
    export interface AccountDataEvents {
        [HELP_SECTION_STATE_EVENT]: HelpSectionState;
    }
}

/**
 * Finds the id of a joined room from a room id or a room alias, without a network request.
 * @param client - The Matrix client.
 * @param idOrAlias - A room id (`!abc:server`) or alias (`#help:server`).
 */
function findJoinedRoom(client: MatrixClient, idOrAlias: string): Room | null {
    const room = idOrAlias.startsWith("#")
        ? (client
              .getRooms()
              .find((r) => r.getCanonicalAlias() === idOrAlias || r.getAltAliases().includes(idOrAlias)) ?? null)
        : client.getRoom(idOrAlias);
    return room?.getMyMembership() === KnownMembership.Join ? room : null;
}

/**
 * Creates the Help section for this account and adds the configured Help rooms to it.
 *
 * Runs on every client start and whenever the member joins a room, but only acts once per section
 * and once per room: the section is created once and placed first, and each configured room is
 * added the first time the member is found in it. Rooms the member already put in another section
 * (such as Favourites) are left where they are.
 * @param client - The Matrix client.
 */
export async function seedHelpSection(client: MatrixClient): Promise<void> {
    const config = SdkConfig.get().holonet_help_section;
    if (!config?.rooms?.length) return;

    const state: HelpSectionState = { ...client.getAccountData(HELP_SECTION_STATE_EVENT)?.getContent() };
    const seededRooms = new Set(state.seeded_rooms ?? []);
    let stateChanged = false;

    if (!state.section_created) {
        const sectionData = getCustomSectionData();
        if (!sectionData[HELP_SECTION_TAG]) {
            sectionData[HELP_SECTION_TAG] = {
                tag: HELP_SECTION_TAG,
                name: config.name ?? "Help",
                spaceId: MetaSpace.Home,
            };
            await SettingsStore.setValue("RoomList.CustomSectionData", null, SettingLevel.ACCOUNT, sectionData);
        }

        // Show the section first, above People and Rooms
        const ordered = getOrderedReorderableSections().filter((tag) => tag !== HELP_SECTION_TAG);
        await SettingsStore.setValue("RoomList.OrderedCustomSections", null, SettingLevel.ACCOUNT, [
            HELP_SECTION_TAG,
            ...ordered,
        ]);

        state.section_created = true;
        stateChanged = true;
    } else if (!getCustomSectionData()[HELP_SECTION_TAG]) {
        // The member deleted the section: respect that and add nothing more
        return;
    }

    for (const idOrAlias of config.rooms) {
        const room = findJoinedRoom(client, idOrAlias);
        if (!room || seededRooms.has(room.roomId)) continue;

        // A room already in a section (Favourites, Low priority, another custom section) stays there
        if (getSectionTagForRoom(room) === null) {
            tagRoom(room, HELP_SECTION_TAG);
        }
        seededRooms.add(room.roomId);
        stateChanged = true;
    }

    if (stateChanged) {
        await client.setAccountData(HELP_SECTION_STATE_EVENT, {
            ...state,
            seeded_rooms: [...seededRooms],
        });
    }
}

let activeClient: MatrixClient | null = null;
let running: Promise<void> | null = null;
let runAgain = false;

/** Runs the seeder, making sure two runs never overlap. */
function run(client: MatrixClient): void {
    if (running) {
        runAgain = true;
        return;
    }
    running = seedHelpSection(client)
        .catch((e) => logger.warn("Holonet: could not set up the Help section", e))
        .finally(() => {
            running = null;
            if (runAgain && client === activeClient) {
                runAgain = false;
                run(client);
            }
        });
}

/** Re-runs the seeder when the member joins a room, in case it is one of the Help rooms. */
function onMyMembership(_room: Room, membership: string): void {
    if (membership === KnownMembership.Join && activeClient) run(activeClient);
}

/**
 * Starts seeding the Help section for the given client. Call once the first sync has completed.
 * @param client - The Matrix client.
 */
export function startHelpSectionSeeder(client: MatrixClient): void {
    activeClient?.off(RoomEvent.MyMembership, onMyMembership);
    activeClient = client;
    runAgain = false;
    client.on(RoomEvent.MyMembership, onMyMembership);
    run(client);
}

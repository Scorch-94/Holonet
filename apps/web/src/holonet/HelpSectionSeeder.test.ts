/*
Copyright 2026 Holonet contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import SdkConfig from "../SdkConfig";
import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import { CHATS_TAG, getCustomSectionData, getOrderedReorderableSections } from "../stores/room-list-v3/section";
import { DefaultTagID } from "../stores/room-list-v3/skip-list/tag";
import { MetaSpace } from "../stores/spaces";
import { getSectionTagForRoom } from "../utils/room/getSectionTagForRoom";
import { tagRoom } from "../utils/room/tagRoom";
import {
    HELP_SECTION_STATE_EVENT,
    HELP_SECTION_TAG,
    type HelpSectionState,
    seedHelpSection,
} from "./HelpSectionSeeder";

vi.mock("../stores/room-list-v3/section", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../stores/room-list-v3/section")>()),
    getCustomSectionData: vi.fn(),
    getOrderedReorderableSections: vi.fn(),
}));
vi.mock("../utils/room/getSectionTagForRoom", () => ({ getSectionTagForRoom: vi.fn() }));
vi.mock("../utils/room/tagRoom", () => ({ tagRoom: vi.fn() }));

/** Builds a joined (or not) room stub with the given id and aliases. */
function mkRoom(roomId: string, alias?: string, membership: string = KnownMembership.Join): Room {
    return {
        roomId,
        getCanonicalAlias: () => alias ?? null,
        getAltAliases: () => [],
        getMyMembership: () => membership,
    } as unknown as Room;
}

/** Builds a client stub holding the given rooms and Help section state. */
function mkClient(rooms: Room[], state?: HelpSectionState): MatrixClient {
    return {
        getRooms: () => rooms,
        getRoom: (roomId: string) => rooms.find((r) => r.roomId === roomId) ?? null,
        getAccountData: vi.fn(() => (state ? { getContent: () => state } : undefined)),
        setAccountData: vi.fn().mockResolvedValue({}),
    } as unknown as MatrixClient;
}

describe("seedHelpSection", () => {
    const helpDesk = mkRoom("!helpdesk:trevors.cloud", "#help-desk:trevors.cloud");
    const archives = mkRoom("!archives:trevors.cloud", "#archives:trevors.cloud");
    const comms = mkRoom("!comms:trevors.cloud", "#comms:trevors.cloud", KnownMembership.Leave);

    beforeEach(() => {
        vi.spyOn(SdkConfig, "get").mockReturnValue({
            holonet_help_section: {
                name: "Help",
                rooms: ["#archives:trevors.cloud", "!helpdesk:trevors.cloud", "#comms:trevors.cloud"],
            },
        } as any);
        vi.spyOn(SettingsStore, "setValue").mockResolvedValue(undefined);
        vi.mocked(getCustomSectionData).mockReturnValue({});
        vi.mocked(getOrderedReorderableSections).mockReturnValue([DefaultTagID.DM, CHATS_TAG]);
        vi.mocked(getSectionTagForRoom).mockReturnValue(null);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.mocked(tagRoom).mockClear();
    });

    it("does nothing when no Help rooms are configured", async () => {
        vi.spyOn(SdkConfig, "get").mockReturnValue({} as any);
        const client = mkClient([helpDesk]);

        await seedHelpSection(client);

        expect(SettingsStore.setValue).not.toHaveBeenCalled();
        expect(client.setAccountData).not.toHaveBeenCalled();
    });

    it("creates the section first in the list and adds the joined Help rooms", async () => {
        const client = mkClient([helpDesk, archives, comms]);

        await seedHelpSection(client);

        expect(SettingsStore.setValue).toHaveBeenCalledWith("RoomList.CustomSectionData", null, SettingLevel.ACCOUNT, {
            [HELP_SECTION_TAG]: { tag: HELP_SECTION_TAG, name: "Help", spaceId: MetaSpace.Home },
        });
        expect(SettingsStore.setValue).toHaveBeenCalledWith(
            "RoomList.OrderedCustomSections",
            null,
            SettingLevel.ACCOUNT,
            [HELP_SECTION_TAG, DefaultTagID.DM, CHATS_TAG],
        );
        expect(tagRoom).toHaveBeenCalledWith(archives, HELP_SECTION_TAG);
        expect(tagRoom).toHaveBeenCalledWith(helpDesk, HELP_SECTION_TAG);
        // Not joined, so left for later
        expect(tagRoom).not.toHaveBeenCalledWith(comms, HELP_SECTION_TAG);
        expect(client.setAccountData).toHaveBeenCalledWith(HELP_SECTION_STATE_EVENT, {
            section_created: true,
            seeded_rooms: [archives.roomId, helpDesk.roomId],
        });
    });

    it("leaves a room in the section the member already put it in", async () => {
        vi.mocked(getSectionTagForRoom).mockImplementation((room) =>
            room === helpDesk ? DefaultTagID.Favourite : null,
        );
        const client = mkClient([helpDesk, archives]);

        await seedHelpSection(client);

        expect(tagRoom).not.toHaveBeenCalledWith(helpDesk, HELP_SECTION_TAG);
        expect(tagRoom).toHaveBeenCalledWith(archives, HELP_SECTION_TAG);
        expect(client.setAccountData).toHaveBeenCalledWith(
            HELP_SECTION_STATE_EVENT,
            expect.objectContaining({ seeded_rooms: [archives.roomId, helpDesk.roomId] }),
        );
    });

    it("never adds a room again once it has been seeded", async () => {
        vi.mocked(getCustomSectionData).mockReturnValue({
            [HELP_SECTION_TAG]: { tag: HELP_SECTION_TAG, name: "Help", spaceId: MetaSpace.Home },
        });
        const client = mkClient([helpDesk, archives], {
            section_created: true,
            seeded_rooms: [helpDesk.roomId, archives.roomId],
        });

        await seedHelpSection(client);

        expect(SettingsStore.setValue).not.toHaveBeenCalled();
        expect(tagRoom).not.toHaveBeenCalled();
        expect(client.setAccountData).not.toHaveBeenCalled();
    });

    it("adds a Help room joined after the section was created", async () => {
        vi.mocked(getCustomSectionData).mockReturnValue({
            [HELP_SECTION_TAG]: { tag: HELP_SECTION_TAG, name: "Help", spaceId: MetaSpace.Home },
        });
        const joinedComms = mkRoom("!comms:trevors.cloud", "#comms:trevors.cloud");
        const client = mkClient([helpDesk, archives, joinedComms], {
            section_created: true,
            seeded_rooms: [helpDesk.roomId, archives.roomId],
        });

        await seedHelpSection(client);

        expect(SettingsStore.setValue).not.toHaveBeenCalled();
        expect(tagRoom).toHaveBeenCalledTimes(1);
        expect(tagRoom).toHaveBeenCalledWith(joinedComms, HELP_SECTION_TAG);
    });

    it("does not recreate the section or add rooms after the member deleted it", async () => {
        const client = mkClient([helpDesk, archives], { section_created: true, seeded_rooms: [] });

        await seedHelpSection(client);

        expect(SettingsStore.setValue).not.toHaveBeenCalled();
        expect(tagRoom).not.toHaveBeenCalled();
        expect(client.setAccountData).not.toHaveBeenCalled();
    });
});

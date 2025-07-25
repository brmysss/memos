import { uniqueId } from "lodash-es";
import { makeAutoObservable } from "mobx";
import { authServiceClient, inboxServiceClient, shortcutServiceClient, userServiceClient } from "@/grpcweb";
import { Inbox } from "@/types/proto/api/v1/inbox_service";
import { Shortcut } from "@/types/proto/api/v1/shortcut_service";
import { User, UserSetting, UserStats } from "@/types/proto/api/v1/user_service";
import { findNearestMatchedLanguage } from "@/utils/i18n";
import workspaceStore from "./workspace";

class LocalState {
  currentUser?: string;
  userSetting?: UserSetting;
  shortcuts: Shortcut[] = [];
  inboxes: Inbox[] = [];
  userMapByName: Record<string, User> = {};
  userStatsByName: Record<string, UserStats> = {};

  // The state id of user stats map.
  statsStateId = uniqueId();

  get tagCount() {
    const tagCount: Record<string, number> = {};
    for (const stats of Object.values(this.userStatsByName)) {
      for (const tag of Object.keys(stats.tagCount)) {
        tagCount[tag] = (tagCount[tag] || 0) + stats.tagCount[tag];
      }
    }
    return tagCount;
  }

  get currentUserStats() {
    if (!this.currentUser) {
      return undefined;
    }
    return this.userStatsByName[this.currentUser];
  }

  constructor() {
    makeAutoObservable(this);
  }

  setPartial(partial: Partial<LocalState>) {
    Object.assign(this, partial);
  }
}

const userStore = (() => {
  const state = new LocalState();

  const getOrFetchUserByName = async (name: string) => {
    const userMap = state.userMapByName;
    if (userMap[name]) {
      return userMap[name] as User;
    }
    const user = await userServiceClient.getUser({
      name: name,
    });
    state.setPartial({
      userMapByName: {
        ...userMap,
        [name]: user,
      },
    });
    return user;
  };

  const getOrFetchUserByUsername = async (username: string) => {
    const userMap = state.userMapByName;
    for (const name in userMap) {
      if (userMap[name].username === username) {
        return userMap[name];
      }
    }
    // Use search instead of the deprecated getUserByUsername
    const { users } = await userServiceClient.searchUsers({
      query: username,
      pageSize: 10,
    });
    const user = users.find((u) => u.username === username);
    if (!user) {
      throw new Error(`User with username ${username} not found`);
    }
    state.setPartial({
      userMapByName: {
        ...userMap,
        [user.name]: user,
      },
    });
    return user;
  };

  const getUserByName = (name: string) => {
    return state.userMapByName[name];
  };

  const fetchUsers = async () => {
    const { users } = await userServiceClient.listUsers({});
    const userMap = state.userMapByName;
    for (const user of users) {
      userMap[user.name] = user;
    }
    state.setPartial({
      userMapByName: userMap,
    });
    return users;
  };

  const updateUser = async (user: Partial<User>, updateMask: string[]) => {
    const updatedUser = await userServiceClient.updateUser({
      user,
      updateMask,
    });
    state.setPartial({
      userMapByName: {
        ...state.userMapByName,
        [updatedUser.name]: updatedUser,
      },
    });
  };

  const deleteUser = async (name: string) => {
    await userServiceClient.deleteUser({ name });
    const userMap = state.userMapByName;
    delete userMap[name];
    state.setPartial({
      userMapByName: userMap,
    });
  };

  const updateUserSetting = async (userSetting: Partial<UserSetting>, updateMask: string[]) => {
    if (!state.currentUser) {
      throw new Error("No current user");
    }
    // Ensure the setting has the proper resource name
    const settingWithName = {
      ...userSetting,
      name: state.currentUser,
    };
    const updatedUserSetting = await userServiceClient.updateUserSetting({
      setting: settingWithName,
      updateMask: updateMask,
    });
    state.setPartial({
      userSetting: UserSetting.fromPartial({
        ...state.userSetting,
        ...updatedUserSetting,
      }),
    });
  };

  const fetchShortcuts = async () => {
    if (!state.currentUser) {
      return;
    }

    const { shortcuts } = await shortcutServiceClient.listShortcuts({ parent: state.currentUser });
    state.setPartial({
      shortcuts,
    });
  };

  const fetchInboxes = async () => {
    if (!state.currentUser) {
      throw new Error("No current user available");
    }

    const { inboxes } = await inboxServiceClient.listInboxes({
      parent: state.currentUser,
    });

    state.setPartial({
      inboxes,
    });
  };

  const updateInbox = async (inbox: Partial<Inbox>, updateMask: string[]) => {
    const updatedInbox = await inboxServiceClient.updateInbox({
      inbox,
      updateMask,
    });
    state.setPartial({
      inboxes: state.inboxes.map((i) => {
        if (i.name === updatedInbox.name) {
          return updatedInbox;
        }
        return i;
      }),
    });
    return updatedInbox;
  };

  const deleteInbox = async (name: string) => {
    await inboxServiceClient.deleteInbox({ name });
    state.setPartial({
      inboxes: state.inboxes.filter((i) => i.name !== name),
    });
  };

  const fetchUserStats = async (user?: string) => {
    const userStatsByName: Record<string, UserStats> = {};
    if (!user) {
      const { userStats } = await userServiceClient.listAllUserStats({});
      for (const stats of userStats) {
        userStatsByName[stats.name] = stats;
      }
    } else {
      const userStats = await userServiceClient.getUserStats({ name: user });
      userStatsByName[user] = userStats;
    }
    state.setPartial({
      userStatsByName: {
        ...state.userStatsByName,
        ...userStatsByName,
      },
    });
  };

  const setStatsStateId = (id = uniqueId()) => {
    state.statsStateId = id;
  };

  return {
    state,
    getOrFetchUserByName,
    getOrFetchUserByUsername,
    getUserByName,
    fetchUsers,
    updateUser,
    deleteUser,
    updateUserSetting,
    fetchShortcuts,
    fetchInboxes,
    updateInbox,
    deleteInbox,
    fetchUserStats,
    setStatsStateId,
  };
})();

export const initialUserStore = async () => {
  try {
    const { user: currentUser } = await authServiceClient.getCurrentSession({});
    if (!currentUser) {
      // If no user is authenticated, we can skip the rest of the initialization.
      userStore.state.setPartial({
        currentUser: undefined,
        userSetting: undefined,
        userMapByName: {},
      });
      return;
    }
    const userSetting = await userServiceClient.getUserSetting({ name: currentUser.name });
    userStore.state.setPartial({
      currentUser: currentUser.name,
      userSetting: UserSetting.fromPartial({
        ...userSetting,
      }),
      userMapByName: {
        [currentUser.name]: currentUser,
      },
    });
    workspaceStore.state.setPartial({
      locale: userSetting.locale,
      appearance: userSetting.appearance,
    });
  } catch {
    // find the nearest matched lang based on the `navigator.language` if the user is unauthenticated or settings retrieval fails.
    const locale = findNearestMatchedLanguage(navigator.language);
    workspaceStore.state.setPartial({
      locale: locale,
    });
  }
};

export default userStore;

/*
 * Copyright (C) 2007 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.android.server.search;

import android.annotation.NonNull;
import android.annotation.UserIdInt;
import android.app.ISearchManager;
import android.app.SearchManager;
import android.app.SearchableInfo;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.ContentObserver;
import android.os.Binder;
import android.os.Bundle;
import android.os.Handler;
import android.os.UserHandle;
import android.os.UserManager;
import android.provider.Settings;
import android.util.ArraySet;
import android.util.Log;
import android.util.SparseArray;

import com.android.internal.annotations.GuardedBy;
import com.android.internal.content.PackageMonitor;
import com.android.internal.os.BackgroundThread;
import com.android.internal.util.DumpUtils;
import com.android.internal.util.IndentingPrintWriter;
import com.android.server.LocalServices;
import com.android.server.SystemService;
import com.android.server.SystemService.TargetUser;
import com.android.server.pm.UserManagerInternal;
import com.android.server.statusbar.StatusBarManagerInternal;

import java.io.FileDescriptor;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.List;

/**
 * The search manager service handles the search UI, and maintains a registry of
 * searchable activities.
 */
public class SearchManagerService extends ISearchManager.Stub {
    private static final String TAG = "SearchManagerService";
    final Handler mHandler;

    private final MyPackageMonitor mMyPackageMonitor;

    public static class Lifecycle extends SystemService {
        private SearchManagerService mService;

        public Lifecycle(Context context) {
            super(context);
        }

        @Override
        public void onStart() {
            mService = new SearchManagerService(getContext());
            publishBinderService(Context.SEARCH_SERVICE, mService);
        }

        @Override
        public void onUserStopped(@NonNull TargetUser user) {
            mService.onCleanupUser(user.getUserIdentifier());
        }
    }

    // Context that the service is running in.
    private final Context mContext;

    // This field is initialized lazily in getSearchables(), and then never modified.
    @GuardedBy("mSearchables")
    private final SparseArray<Searchables> mSearchables = new SparseArray<>();

    private final UserManagerInternal mUserManagerInternal;

    /**
     * Initializes the Search Manager service in the provided system context.
     * Only one instance of this object should be created!
     *
     * @param context to use for accessing DB, window manager, etc.
     */
    public SearchManagerService(Context context)  {
        mContext = context;
        mMyPackageMonitor = new MyPackageMonitor();
        mMyPackageMonitor.register(context, null, UserHandle.ALL, true);
        new GlobalSearchProviderObserver(context.getContentResolver());
        mHandler = BackgroundThread.getHandler();
        mUserManagerInternal = LocalServices.getService(UserManagerInternal.class);
    }

    private Searchables getSearchables(int userId) {
        final long token = Binder.clearCallingIdentity();
        try {
            final UserManager um = mContext.getSystemService(UserManager.class);
            if (um.getUserInfo(userId) == null) {
                throw new IllegalStateException("User " + userId + " doesn't exist");
            }
            if (!um.isUserUnlockingOrUnlocked(userId)) {
                throw new IllegalStateException("User " + userId + " isn't unlocked");
            }
        } finally {
            Binder.restoreCallingIdentity(token);
        }
        synchronized (mSearchables) {
            Searchables searchables = mSearchables.get(userId);
            if (searchables == null) {
                searchables = new Searchables(mContext, userId);
                mSearchables.put(userId, searchables);
            }

            searchables.updateSearchableListIfNeeded();
            return searchables;
        }
    }

    private void onCleanupUser(int userId) {
        synchronized (mSearchables) {
            mSearchables.remove(userId);
        }
    }

    /**
     * Refreshes the "searchables" list when packages are added/removed.
     */
    class MyPackageMonitor extends PackageMonitor {
        /**
         * Packages that are appeared, disappeared, or modified for whatever reason.
         */
        private final ArrayList<String> mChangedPackages = new ArrayList<>();

        /**
         * {@code true} if one or more packages that contain {@link SearchableInfo} appeared.
         */
        private boolean mSearchablePackageAppeared = false;

        @Override
        public void onBeginPackageChanges() {
            clearPackageChangeState();
        }

        @Override
        public void onPackageAppeared(String packageName, int reason) {
            if (!mSearchablePackageAppeared) {
                // Check if the new appeared package contains SearchableInfo.
                mSearchablePackageAppeared =
                        hasSearchableForPackage(packageName, getChangingUserId());
            }
            mChangedPackages.add(packageName);
        }

        @Override
        public void onPackageDisappeared(String packageName, int reason) {
            mChangedPackages.add(packageName);
        }

        @Override
        public void onPackageModified(String packageName) {
            mChangedPackages.add(packageName);
        }

        @Override
        public void onFinishPackageChanges() {
            onFinishPackageChangesInternal();
            clearPackageChangeState();
        }

        private void clearPackageChangeState() {
            mChangedPackages.clear();
            mSearchablePackageAppeared = false;
        }

        private boolean hasSearchableForPackage(String packageName, int userId) {
            final List<ResolveInfo> searchList = querySearchableActivities(mContext,
                    new Intent(Intent.ACTION_SEARCH).setPackage(packageName), userId);
            if (!searchList.isEmpty()) {
                return true;
            }

            final List<ResolveInfo> webSearchList = querySearchableActivities(mContext,
                    new Intent(Intent.ACTION_WEB_SEARCH).setPackage(packageName), userId);
            if (!webSearchList.isEmpty()) {
                return true;
            }

            final List<ResolveInfo> globalSearchList = querySearchableActivities(mContext,
                    new Intent(SearchManager.INTENT_ACTION_GLOBAL_SEARCH).setPackage(packageName),
                    userId);
            return !globalSearchList.isEmpty();
        }

        private boolean shouldRebuildSearchableList(@UserIdInt int changingUserId) {
            // This method is guaranteed to be called only on getRegisteredHandler()
            if (mSearchablePackageAppeared) {
                return true;
            }

            ArraySet<String> knownSearchablePackageNames = new ArraySet<>();
            synchronized (mSearchables) {
                Searchables searchables = mSearchables.get(changingUserId);
                if (searchables != null) {
                    knownSearchablePackageNames = searchables.getKnownSearchablePackageNames();
                }
            }

            final int numOfPackages = mChangedPackages.size();
            for (int i = 0; i < numOfPackages; i++) {
                final String packageName = mChangedPackages.get(i);
                if (knownSearchablePackageNames.contains(packageName)) {
                    return true;
                }
            }

            return false;
        }

        private void onFinishPackageChangesInternal() {
            final int changingUserId = getChangingUserId();
            if (!shouldRebuildSearchableList(changingUserId)) {
                return;
            }
            synchronized (mSearchables) {
                // Invalidate the searchable list.
                Searchables searchables = mSearchables.get(changingUserId);
                if (searchables != null) {
                    searchables.invalidateSearchableList();
                }
            }

            // Inform all listeners that the list of searchables has been updated.
            Intent intent = new Intent(SearchManager.INTENT_ACTION_SEARCHABLES_CHANGED);
            intent.addFlags(Intent.FLAG_RECEIVER_REPLACE_PENDING
                    | Intent.FLAG_RECEIVER_REGISTERED_ONLY_BEFORE_BOOT);
            mContext.sendBroadcastAsUser(intent, new UserHandle(changingUserId));
        }
    }

    @NonNull
    static List<ResolveInfo> querySearchableActivities(Context context, Intent searchIntent,
            @UserIdInt int userId) {
        final List<ResolveInfo> activities = context.getPackageManager()
                .queryIntentActivitiesAsUser(searchIntent, PackageManager.GET_META_DATA
                        | PackageManager.MATCH_INSTANT
                        | PackageManager.MATCH_DEBUG_TRIAGED_MISSING, userId);
        return activities;
    }


    class GlobalSearchProviderObserver extends ContentObserver {
        private final ContentResolver mResolver;

        public GlobalSearchProviderObserver(ContentResolver resolver) {
            super(null);
            mResolver = resolver;
            mResolver.registerContentObserver(
                    Settings.Secure.getUriFor(Settings.Secure.SEARCH_GLOBAL_SEARCH_ACTIVITY),
                    false /* notifyDescendants */,
                    this);
        }

        @Override
        public void onChange(boolean selfChange) {
            synchronized (mSearchables) {
                for (int i = 0; i < mSearchables.size(); i++) {
                    mSearchables.valueAt(i).invalidateSearchableList();
                }
            }
            Intent intent = new Intent(SearchManager.INTENT_GLOBAL_SEARCH_ACTIVITY_CHANGED);
            intent.addFlags(Intent.FLAG_RECEIVER_REPLACE_PENDING);
            mContext.sendBroadcastAsUser(intent, UserHandle.ALL);
        }
    }

    //
    // Searchable activities API
    //

    /**
     * Returns the SearchableInfo for a given activity.
     *
     * @param launchActivity The activity from which we're launching this search.
     * @return Returns a SearchableInfo record describing the parameters of the search,
     * or null if no searchable metadata was available.
     */
    @Override
    public SearchableInfo getSearchableInfo(final ComponentName launchActivity) {
        if (launchActivity == null) {
            Log.e(TAG, "getSearchableInfo(), activity == null");
            return null;
        }
        return getSearchables(UserHandle.getCallingUserId()).getSearchableInfo(launchActivity);
    }

    /**
     * Returns a list of the searchable activities that can be included in global search.
     */
    @Override
    public List<SearchableInfo> getSearchablesInGlobalSearch() {
        return getSearchables(UserHandle.getCallingUserId()).getSearchablesInGlobalSearchList();
    }

    @Override
    public List<ResolveInfo> getGlobalSearchActivities() {
        return getSearchables(UserHandle.getCallingUserId()).getGlobalSearchActivities();
    }

    /**
     * Gets the name of the global search activity.
     */
    @Override
    public ComponentName getGlobalSearchActivity() {
        return getSearchables(UserHandle.getCallingUserId()).getGlobalSearchActivity();
    }

    /**
     * Gets the name of the web search activity.
     */
    @Override
    public ComponentName getWebSearchActivity() {
        return getSearchables(UserHandle.getCallingUserId()).getWebSearchActivity();
    }

    @Override
    public void launchAssist(int userHandle, Bundle args) {
        // Currently, visible background users are not allowed to launch assist.(b/332222893)
        // TODO(b/368715893): Consider indirect calls from system service when checking the
        // calling user.
        final int callingUserId = UserHandle.getCallingUserId();
        if (mUserManagerInternal.isVisibleBackgroundFullUser(callingUserId)) {
            throw new SecurityException("Visible background user(u" + callingUserId
                    + ") is not permitted to launch assist.");
        }
        StatusBarManagerInternal statusBarManager =
                LocalServices.getService(StatusBarManagerInternal.class);
        if (statusBarManager != null) {
            statusBarManager.startAssist(args);
        }
    }

    @Override
    public void dump(FileDescriptor fd, PrintWriter pw, String[] args) {
        if (!DumpUtils.checkDumpPermission(mContext, TAG, pw)) return;

        IndentingPrintWriter ipw = new IndentingPrintWriter(pw, "  ");
        synchronized (mSearchables) {
            for (int i = 0; i < mSearchables.size(); i++) {
                ipw.print("\nUser: "); ipw.println(mSearchables.keyAt(i));
                ipw.increaseIndent();
                mSearchables.valueAt(i).dump(fd, ipw, args);
                ipw.decreaseIndent();
            }
        }
    }
}

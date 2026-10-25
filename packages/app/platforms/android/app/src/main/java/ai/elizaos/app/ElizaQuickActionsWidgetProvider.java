package ai.elizaos.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

public class ElizaQuickActionsWidgetProvider extends AppWidgetProvider {

    @Override
    public void onUpdate(
            Context context,
            AppWidgetManager appWidgetManager,
            int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            appWidgetManager.updateAppWidget(appWidgetId, buildRemoteViews(context));
        }
    }

    private static RemoteViews buildRemoteViews(Context context) {
        RemoteViews views = new RemoteViews(
                context.getPackageName(),
                R.layout.eliza_quick_actions_widget);
        views.setOnClickPendingIntent(
                R.id.widget_ask,
                pendingIntent(
                        context,
                        1,
                        "elizaos://chat?source=android-widget&action=ask"));
        views.setOnClickPendingIntent(
                R.id.widget_voice,
                pendingIntent(
                        context,
                        2,
                        "elizaos://voice?source=android-widget&action=voice&voice=1"));
        views.setOnClickPendingIntent(
                R.id.widget_daily_brief,
                pendingIntent(
                        context,
                        3,
                        "elizaos://lifeops/daily-brief?source=android-widget&action=lifeops.daily-brief"));
        views.setOnClickPendingIntent(
                R.id.widget_new_task,
                pendingIntent(
                        context,
                        4,
                        "elizaos://lifeops/task/new?source=android-widget&action=lifeops.create"));
        return views;
    }

    private static PendingIntent pendingIntent(Context context, int requestCode, String uri) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse(uri));
        intent.setFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}

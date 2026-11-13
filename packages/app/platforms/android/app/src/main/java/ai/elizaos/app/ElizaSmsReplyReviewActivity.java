package ai.elizaos.app;

import ai.eliza.plugins.messages.ReviewedSmsSend;
import android.app.Activity;
import android.app.KeyguardManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.method.ScrollingMovementMethod;
import android.util.Log;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The owner's review of one reply Eliza Cloud drafted for an incoming text. It shows the exact
 * recipient, SIM and text of the `sms.send.v1` operation; only the Send press here sends it, through
 * the shared reviewed send. Edit moves the draft to the Messages composer, Discard drops it. Not
 * exported: it opens only from this app's own review notice.
 */
public class ElizaSmsReplyReviewActivity extends Activity {
    static final String EXTRA_OPERATION_ID = "ai.elizaos.app.extra.SMS_REPLY_OPERATION_ID";

    private static final ExecutorService STORE = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private ElizaSmsReplyProposals.Proposal proposal;
    private TextView summary, message, notice;
    private Button send, edit, discard;
    private boolean sending;

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(24), dp(20), dp(24));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(content);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        TextView heading = new TextView(this);
        heading.setText("Eliza drafted this reply. Nothing is sent until you press Send.");
        content.addView(heading);
        summary = new TextView(this);
        summary.setPadding(0, dp(12), 0, 0);
        content.addView(summary);
        message = new TextView(this);
        message.setPadding(0, dp(12), 0, dp(12));
        message.setTextIsSelectable(true);
        message.setMovementMethod(new ScrollingMovementMethod());
        message.setContentDescription("Reply text");
        content.addView(message);
        TextView charges = new TextView(this);
        charges.setText("Carrier charges may apply.");
        content.addView(charges);
        send = button("Send");
        // An overlay must not be able to steer the owner's Send press.
        send.setFilterTouchesWhenObscured(true);
        send.setOnClickListener(view -> send());
        content.addView(send);
        edit = button("Edit in Messages");
        edit.setOnClickListener(view -> edit());
        content.addView(edit);
        discard = button("Discard");
        discard.setOnClickListener(view -> discard());
        content.addView(discard);
        notice = new TextView(this);
        notice.setPadding(0, dp(12), 0, 0);
        content.addView(notice);
        setContentView(scroll);
        setEnabled(false);
        load(getIntent() == null ? null : getIntent().getStringExtra(EXTRA_OPERATION_ID));
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        if (sending) return;
        setIntent(intent);
        load(intent == null ? null : intent.getStringExtra(EXTRA_OPERATION_ID));
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setMinHeight(dp(56));
        return button;
    }

    private void setEnabled(boolean enabled) {
        send.setEnabled(enabled);
        edit.setEnabled(enabled);
        discard.setEnabled(enabled);
    }

    private void load(String operationId) {
        proposal = null;
        setEnabled(false);
        summary.setText("");
        message.setText("");
        notice.setText("");
        if (operationId == null) {
            notice.setText("This reply is no longer waiting for review.");
            return;
        }
        STORE.execute(() -> {
            ElizaSmsReplyProposals.Proposal found = null;
            String failure = null;
            try {
                found = ElizaSmsReviewedSend.proposals(this).get(operationId, System.currentTimeMillis());
            } catch (Exception unreadable) {
                failure = "This reply could not be read. Nothing was sent.";
            }
            final ElizaSmsReplyProposals.Proposal shown = found;
            final String problem = failure != null ? failure : found == null ? "This reply is no longer waiting for review. Nothing more will be sent." : null;
            main.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (shown == null) {
                    ElizaSmsReviewedSend.cancelReviewNotice(this, operationId);
                    notice.setText(problem);
                    return;
                }
                proposal = shown;
                summary.setText("To: " + shown.recipient + "\nFrom SIM: subscription " + shown.subscriptionId);
                message.setText(shown.body);
                setEnabled(true);
            });
        });
    }

    private String blocker() {
        KeyguardManager lock = getSystemService(KeyguardManager.class);
        if (lock == null || lock.isDeviceLocked()) return "Unlock the phone to send.";
        return null;
    }

    private void send() {
        final ElizaSmsReplyProposals.Proposal reviewed = proposal;
        if (sending || reviewed == null) return;
        String blocked = blocker();
        if (blocked != null) {
            notice.setText(blocked);
            return;
        }
        sending = true;
        setEnabled(false);
        notice.setText("Sending…");
        try {
            ReviewedSmsSend.send(this, ElizaSmsReviewedSend.HOST, reviewed.operationId, reviewed.recipients(), reviewed.body,
                    reviewed.subscriptionId, status -> finished(reviewed, status));
        } catch (IllegalArgumentException invalid) {
            finished(reviewed, ReviewedSmsSend.NOT_SENT);
        }
    }

    private void finished(ElizaSmsReplyProposals.Proposal reviewed, String status) {
        Log.i(ElizaSmsReviewedSend.TAG, "Reviewed SMS gateway reply finished with status " + status + ".");
        boolean journaled = !ReviewedSmsSend.NOT_SENT.equals(status);
        if (journaled) {
            // The journal now holds this operation: the draft is decided and can never send again.
            forget(reviewed.operationId);
        }
        if (isFinishing() || isDestroyed()) return;
        sending = false;
        notice.setText(ElizaSmsReviewedSend.label(status));
        if (journaled) proposal = null;
        else setEnabled(true);
    }

    private void edit() {
        final ElizaSmsReplyProposals.Proposal draft = proposal;
        if (sending || draft == null) return;
        forget(draft.operationId);
        startActivity(ElizaSmsReviewedSend.composeIntent(this, draft.recipient, draft.body, "sms-reply-review"));
        finish();
    }

    private void discard() {
        final ElizaSmsReplyProposals.Proposal draft = proposal;
        if (sending || draft == null) return;
        forget(draft.operationId);
        Log.i(ElizaSmsReviewedSend.TAG, "SMS gateway reply discarded by the owner.");
        finish();
    }

    private void forget(String operationId) {
        ElizaSmsReviewedSend.cancelReviewNotice(this, operationId);
        final android.content.Context app = getApplicationContext();
        STORE.execute(() -> {
            try {
                ElizaSmsReviewedSend.proposals(app).remove(operationId);
            } catch (Exception unwritable) {
                // A draft left behind can only be reviewed again; its journaled operation never sends twice.
                Log.w(ElizaSmsReviewedSend.TAG, "SMS reply draft could not be removed.");
            }
        });
    }
}

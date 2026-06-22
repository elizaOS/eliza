import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { ConversationUndoToast } from "./ConversationUndoToast";
import {
	dismissConversationUndo,
	showConversationUndo,
} from "./conversation-undo-store";

/**
 * Soft-undo toast after a conversation reset (#8929). Restores the previous
 * conversation on tap (Undo) or a left-swipe; auto-dismisses after 3s.
 */
const meta = {
	title: "Shell/ConversationUndoToast",
	component: ConversationUndoToast,
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => (
			<div
				style={{
					position: "relative",
					minHeight: 320,
					background:
						"radial-gradient(140% 120% at 50% -10%, #ffd9a8 0%, #e87b6e 40%, #241128 100%)",
				}}
			>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof ConversationUndoToast>;

export default meta;
type Story = StoryObj<typeof meta>;

/** AfterClear: the toast is shown with a long duration so it stays visible. */
export const AfterClear: Story = {
	render: () => {
		React.useEffect(() => {
			showConversationUndo({
				label: "Conversation cleared",
				actionLabel: "Undo",
				onUndo: () => {},
			});
			return () => dismissConversationUndo();
		}, []);
		return <ConversationUndoToast />;
	},
};

/** A button that triggers the toast on demand (interactive). */
export const Triggerable: Story = {
	render: () => {
		const fire = () =>
			showConversationUndo({
				label: "Conversation cleared",
				actionLabel: "Undo",
				onUndo: () => {},
			});
		return (
			<div style={{ padding: 24 }}>
				<button
					type="button"
					onClick={fire}
					style={{
						borderRadius: 999,
						border: "1px solid rgba(255,255,255,0.2)",
						background: "rgba(255,255,255,0.1)",
						color: "white",
						padding: "8px 16px",
					}}
				>
					Reset conversation
				</button>
				<ConversationUndoToast />
			</div>
		);
	},
};

/**
 * Native AppKit renderer for the eliza.native-transcript/v1 frame (spike).
 *
 * Decodes the serialized transcript JSON produced by
 * packages/ui/src/chat/native-transcript/spec.ts and draws it as a real
 * NSScrollView stack inserted ABOVE the window's WKWebView, so the desktop
 * chat overlay can render its transcript with genuine macOS UI over the
 * native glass (window-effects.mm's NSVisualEffectView sits below the
 * webview; this view's background is fully transparent so that glass shows
 * through). Compiled to src/libMacTranscriptView.dylib by
 * scripts/build-macos-transcript.sh and loaded over Bun FFI by
 * src/native/mac-transcript.ts.
 *
 * Contract discipline: decoding is tolerant (unknown segment kinds render as
 * labeled placeholder rows, missing fields are skipped, a bad frame renders
 * an error row instead of crashing), and actions flow BACK to JS only as the
 * plain strings the DOM widgets pass to sendActionMessage — a poll-drained
 * queue (transcriptTakePendingAction) rather than a C callback, matching the
 * poll conventions window-effects.mm already established
 * (elizaOnboardingGetChoice). Never invent a second action channel.
 *
 * Spike scope: text turns (user right-aligned chips / assistant left
 * full-width, markdown-ish), code blocks (monospaced), reasoning + tool-event
 * + failure side channels, interactive choice buttons + permission-card
 * buttons (they enqueue the documented action strings), and labeled
 * placeholder rows for the remaining widget kinds. Full widget parity is the
 * follow-up, not this file.
 */

#import <Cocoa/Cocoa.h>
#include <stdlib.h>
#include <string.h>

static NSString *const kElizaNativeTranscriptScrollIdentifier =
	@"ElizaNativeTranscriptScroll";

// ---------------------------------------------------------------------------
// Pending-action queue (native → JS, poll-drained over FFI)
// ---------------------------------------------------------------------------

static NSMutableArray<NSString *> *elizaTranscriptPendingActions(void) {
	static NSMutableArray<NSString *> *queue = nil;
	static dispatch_once_t onceToken;
	dispatch_once(&onceToken, ^{
		queue = [[NSMutableArray alloc] init];
	});
	return queue;
}

static void elizaTranscriptEnqueueAction(NSString *message) {
	if ([message length] == 0) {
		return;
	}
	NSMutableArray<NSString *> *queue = elizaTranscriptPendingActions();
	@synchronized(queue) {
		[queue addObject:message];
	}
}

/** AppKit work must run on the main thread; FFI calls arrive on Bun's JS
 *  thread in the shell but on the main thread in the standalone harness, so
 *  guard the dispatch_sync (window-effects.mm can assume off-main callers;
 *  this dylib cannot). */
static void elizaTranscriptRunOnMain(void (^block)(void)) {
	if ([NSThread isMainThread]) {
		block();
	} else {
		dispatch_sync(dispatch_get_main_queue(), block);
	}
}

// ---------------------------------------------------------------------------
// Palette — dark glass, orange #ff7a3d accent ONLY (no blue anywhere)
// ---------------------------------------------------------------------------

static NSColor *elizaTranscriptAccentColor(void) {
	return [NSColor colorWithSRGBRed:1.0
							   green:(122.0 / 255.0)
								blue:(61.0 / 255.0)
							   alpha:1.0];
}

static NSColor *elizaTranscriptPrimaryTextColor(void) {
	return [NSColor colorWithCalibratedWhite:0.96 alpha:0.95];
}

static NSColor *elizaTranscriptDimTextColor(void) {
	return [NSColor colorWithCalibratedWhite:0.78 alpha:0.62];
}

static NSColor *elizaTranscriptFaintTextColor(void) {
	return [NSColor colorWithCalibratedWhite:0.70 alpha:0.45];
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Flipped so rows lay out top-down with a simple y cursor. */
@interface ElizaTranscriptDocumentView : NSView
@end

@implementation ElizaTranscriptDocumentView
- (BOOL)isFlipped {
	return YES;
}
- (BOOL)isOpaque {
	return NO;
}
@end

/** Rounded translucent container (user chips, code blocks, widget frames). */
@interface ElizaTranscriptCardView : NSView
@property(nonatomic, strong) NSColor *elizaFillColor;
@property(nonatomic, strong) NSColor *elizaStrokeColor;
@property(nonatomic, assign) CGFloat elizaCornerRadius;
@end

@implementation ElizaTranscriptCardView
- (BOOL)isOpaque {
	return NO;
}
- (BOOL)isFlipped {
	return YES;
}
- (void)drawRect:(NSRect)dirtyRect {
	(void)dirtyRect;
	NSBezierPath *path =
		[NSBezierPath bezierPathWithRoundedRect:NSInsetRect([self bounds], 0.5, 0.5)
										xRadius:self.elizaCornerRadius
										yRadius:self.elizaCornerRadius];
	if (self.elizaFillColor != nil) {
		[self.elizaFillColor setFill];
		[path fill];
	}
	if (self.elizaStrokeColor != nil) {
		[self.elizaStrokeColor setStroke];
		[path setLineWidth:1.0];
		[path stroke];
	}
}
@end

/** Chip button carrying the exact sendActionMessage string it emits. */
@interface ElizaTranscriptActionButton : NSButton
@property(nonatomic, copy) NSString *elizaActionMessage;
@end

@implementation ElizaTranscriptActionButton
@end

@interface ElizaTranscriptActionSink : NSObject
+ (instancetype)shared;
- (void)actionTapped:(id)sender;
@end

@implementation ElizaTranscriptActionSink
+ (instancetype)shared {
	static ElizaTranscriptActionSink *sink = nil;
	static dispatch_once_t onceToken;
	dispatch_once(&onceToken, ^{
		sink = [[ElizaTranscriptActionSink alloc] init];
	});
	return sink;
}

- (void)actionTapped:(id)sender {
	if ([sender isKindOfClass:[ElizaTranscriptActionButton class]]) {
		elizaTranscriptEnqueueAction(
			[(ElizaTranscriptActionButton *)sender elizaActionMessage]);
	}
}
@end

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

static NSString *elizaTranscriptString(id value) {
	return [value isKindOfClass:[NSString class]] ? (NSString *)value : @"";
}

static NSDictionary *elizaTranscriptDict(id value) {
	return [value isKindOfClass:[NSDictionary class]] ? (NSDictionary *)value
													  : nil;
}

static NSArray *elizaTranscriptArray(id value) {
	return [value isKindOfClass:[NSArray class]] ? (NSArray *)value : nil;
}

/** Markdown-ish body text: Foundation's markdown parser when available (bold /
 *  italic / inline code survive), plain text otherwise; the whole run is then
 *  re-based onto the system font + transcript palette so parser defaults never
 *  leak light-mode colors into the dark glass. */
static NSAttributedString *elizaTranscriptBody(NSString *text,
											   NSColor *color,
											   CGFloat fontSize) {
	NSAttributedString *parsed = nil;
	if (@available(macOS 12.0, *)) {
		NSAttributedStringMarkdownParsingOptions *options =
			[[NSAttributedStringMarkdownParsingOptions alloc] init];
		options.interpretedSyntax =
			NSAttributedStringMarkdownInterpretedSyntaxInlineOnlyPreservingWhitespace;
		NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
		if (data != nil) {
			parsed = [[NSAttributedString alloc] initWithMarkdown:data
														  options:options
														  baseURL:nil
															error:nil];
		}
	}
	NSMutableAttributedString *out =
		parsed != nil
			? [parsed mutableCopy]
			: [[NSMutableAttributedString alloc] initWithString:text];
	NSRange full = NSMakeRange(0, [out length]);
	NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
	paragraph.lineSpacing = 2.0;
	[out addAttribute:NSForegroundColorAttributeName value:color range:full];
	[out addAttribute:NSParagraphStyleAttributeName value:paragraph range:full];
	[out enumerateAttribute:NSFontAttributeName
					inRange:full
					options:0
				 usingBlock:^(id value, NSRange range, BOOL *stop) {
		(void)stop;
		NSFont *font = [value isKindOfClass:[NSFont class]] ? (NSFont *)value
															: nil;
		NSFontDescriptorSymbolicTraits traits =
			font != nil ? [[font fontDescriptor] symbolicTraits] : 0;
		if (traits & NSFontDescriptorTraitMonoSpace) {
			[out addAttribute:NSFontAttributeName
						value:[NSFont monospacedSystemFontOfSize:fontSize - 1.0
														  weight:NSFontWeightRegular]
						range:range];
			return;
		}
		NSFont *base = [NSFont
			systemFontOfSize:fontSize
					  weight:(traits & NSFontDescriptorTraitBold)
								 ? NSFontWeightSemibold
								 : NSFontWeightRegular];
		if (traits & NSFontDescriptorTraitItalic) {
			base = [[NSFontManager sharedFontManager] convertFont:base
													  toHaveTrait:NSItalicFontMask];
		}
		[out addAttribute:NSFontAttributeName value:base range:range];
	}];
	return out;
}

static NSAttributedString *elizaTranscriptMonoText(NSString *text,
												   NSColor *color,
												   CGFloat fontSize) {
	NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
	paragraph.lineSpacing = 1.0;
	// Character wrapping: code has long unbroken tokens that word wrap would
	// push out of the card.
	paragraph.lineBreakMode = NSLineBreakByCharWrapping;
	return [[NSAttributedString alloc]
		initWithString:text
			attributes:@{
				NSFontAttributeName : [NSFont
					monospacedSystemFontOfSize:fontSize
										weight:NSFontWeightRegular],
				NSForegroundColorAttributeName : color,
				NSParagraphStyleAttributeName : paragraph,
			}];
}

/** Measured wrapping label. The caller repositions the returned frame. */
static NSTextField *elizaTranscriptLabel(NSAttributedString *text,
										 CGFloat maxWidth) {
	NSTextField *label = [NSTextField wrappingLabelWithString:@""];
	[label setAttributedStringValue:text];
	[label setSelectable:NO];
	[label setDrawsBackground:NO];
	NSSize size = [[label cell]
		cellSizeForBounds:NSMakeRect(0, 0, maxWidth, CGFLOAT_MAX)];
	[label setFrame:NSMakeRect(0, 0, MIN(maxWidth, ceil(size.width)),
							   ceil(size.height))];
	return label;
}

static NSTextField *elizaTranscriptSingleLineLabel(NSAttributedString *text,
												   CGFloat maxWidth) {
	NSTextField *label = [NSTextField labelWithAttributedString:text];
	[[label cell] setLineBreakMode:NSLineBreakByTruncatingTail];
	[label sizeToFit];
	NSRect frame = [label frame];
	frame.size.width = MIN(frame.size.width, maxWidth);
	[label setFrame:frame];
	return label;
}

/** Small uppercase mono tag ("CHOICE", "FORM", …) in the accent color. */
static NSTextField *elizaTranscriptKindTag(NSString *kind, CGFloat maxWidth) {
	NSAttributedString *text = [[NSAttributedString alloc]
		initWithString:[kind uppercaseString]
			attributes:@{
				NSFontAttributeName : [NSFont
					monospacedSystemFontOfSize:9.0
										weight:NSFontWeightMedium],
				NSForegroundColorAttributeName : elizaTranscriptAccentColor(),
				NSKernAttributeName : @1.2,
			}];
	return elizaTranscriptSingleLineLabel(text, maxWidth);
}

static ElizaTranscriptActionButton *
elizaTranscriptChipButton(NSString *label, NSString *actionMessage,
						  BOOL accent) {
	ElizaTranscriptActionButton *button =
		[[ElizaTranscriptActionButton alloc] initWithFrame:NSZeroRect];
	[button setBezelStyle:NSBezelStyleRegularSquare];
	[button setBordered:NO];
	[button setWantsLayer:YES];
	button.layer.cornerRadius = 13.0;
	button.layer.backgroundColor =
		[[NSColor colorWithCalibratedWhite:1.0 alpha:accent ? 0.10 : 0.07]
			CGColor];
	button.layer.borderWidth = 1.0;
	button.layer.borderColor =
		accent ? [[elizaTranscriptAccentColor() colorWithAlphaComponent:0.55]
					 CGColor]
			   : [[NSColor colorWithCalibratedWhite:1.0 alpha:0.12] CGColor];
	NSAttributedString *title = [[NSAttributedString alloc]
		initWithString:label
			attributes:@{
				NSFontAttributeName : [NSFont systemFontOfSize:12.0
														weight:NSFontWeightMedium],
				NSForegroundColorAttributeName :
					accent ? elizaTranscriptAccentColor()
						   : elizaTranscriptPrimaryTextColor(),
			}];
	[button setAttributedTitle:title];
	[button sizeToFit];
	NSRect frame = [button frame];
	frame.size.width += 20.0;
	frame.size.height = MAX(frame.size.height + 6.0, 26.0);
	[button setFrame:frame];
	button.elizaActionMessage = actionMessage;
	[button setTarget:[ElizaTranscriptActionSink shared]];
	[button setAction:@selector(actionTapped:)];
	// Passive chips (navigate/prompt followups need host-side handling the
	// spike doesn't wire) render but do not enqueue.
	[button setEnabled:[actionMessage length] > 0];
	return button;
}

// ---------------------------------------------------------------------------
// Row builders — each appends into the flipped document view at *y
// ---------------------------------------------------------------------------

static const CGFloat kElizaTranscriptPadding = 16.0;
static const CGFloat kElizaTranscriptRowGap = 8.0;
static const CGFloat kElizaTranscriptTurnGap = 18.0;

static void elizaTranscriptAppend(NSView *doc, NSView *row, CGFloat x,
								  CGFloat *y) {
	NSRect frame = [row frame];
	frame.origin.x = x;
	frame.origin.y = *y;
	[row setFrame:frame];
	[doc addSubview:row];
	*y += frame.size.height + kElizaTranscriptRowGap;
}

/** Chip row layout: buttons flow left-to-right and wrap. */
static void elizaTranscriptAppendChips(NSView *doc,
									   NSArray<NSButton *> *chips,
									   CGFloat x, CGFloat maxWidth,
									   CGFloat *y) {
	CGFloat cx = x;
	CGFloat rowTop = *y;
	CGFloat rowHeight = 0.0;
	for (NSButton *chip in chips) {
		NSRect frame = [chip frame];
		if (cx > x && cx + frame.size.width > x + maxWidth) {
			cx = x;
			rowTop += rowHeight + 6.0;
			rowHeight = 0.0;
		}
		frame.origin.x = cx;
		frame.origin.y = rowTop;
		[chip setFrame:frame];
		[doc addSubview:chip];
		cx += frame.size.width + 6.0;
		rowHeight = MAX(rowHeight, frame.size.height);
	}
	if ([chips count] > 0) {
		*y = rowTop + rowHeight + kElizaTranscriptRowGap;
	}
}

static void elizaTranscriptAppendCode(NSView *doc, NSDictionary *segment,
									  CGFloat x, CGFloat width, CGFloat *y) {
	NSString *code = elizaTranscriptString(segment[@"code"]);
	NSString *lang = elizaTranscriptString(segment[@"lang"]);
	const CGFloat pad = 10.0;
	NSTextField *body = elizaTranscriptLabel(
		elizaTranscriptMonoText(code, elizaTranscriptPrimaryTextColor(), 11.5),
		width - pad * 2.0);
	CGFloat headerHeight = 0.0;
	NSTextField *langTag = nil;
	if ([lang length] > 0) {
		langTag = elizaTranscriptKindTag(lang, width - pad * 2.0);
		headerHeight = [langTag frame].size.height + 4.0;
	}
	ElizaTranscriptCardView *card = [[ElizaTranscriptCardView alloc]
		initWithFrame:NSMakeRect(0, 0, width,
								 [body frame].size.height + headerHeight +
									 pad * 2.0)];
	card.elizaFillColor = [NSColor colorWithCalibratedWhite:0.0 alpha:0.34];
	card.elizaStrokeColor = [NSColor colorWithCalibratedWhite:1.0 alpha:0.08];
	card.elizaCornerRadius = 10.0;
	CGFloat innerY = pad;
	if (langTag != nil) {
		NSRect tagFrame = [langTag frame];
		tagFrame.origin = NSMakePoint(pad, innerY);
		[langTag setFrame:tagFrame];
		[card addSubview:langTag];
		innerY += headerHeight;
	}
	NSRect bodyFrame = [body frame];
	bodyFrame.origin = NSMakePoint(pad, innerY);
	[body setFrame:bodyFrame];
	[card addSubview:body];
	elizaTranscriptAppend(doc, card, x, y);
}

/** Placeholder card: kind tag + one summary line. The full widget rendering
 *  is out of spike scope; the row proves tolerant decoding of every kind. */
static void elizaTranscriptAppendPlaceholder(NSView *doc, NSString *kind,
											 NSString *summary, CGFloat x,
											 CGFloat width, CGFloat *y) {
	const CGFloat pad = 10.0;
	NSTextField *tag = elizaTranscriptKindTag(kind, width - pad * 2.0);
	NSTextField *body = nil;
	CGFloat bodyHeight = 0.0;
	if ([summary length] > 0) {
		body = elizaTranscriptLabel(
			elizaTranscriptBody(summary, elizaTranscriptDimTextColor(), 12.0),
			width - pad * 2.0);
		bodyHeight = [body frame].size.height + 4.0;
	}
	ElizaTranscriptCardView *card = [[ElizaTranscriptCardView alloc]
		initWithFrame:NSMakeRect(0, 0, width,
								 [tag frame].size.height + bodyHeight +
									 pad * 2.0)];
	card.elizaFillColor = nil;
	card.elizaStrokeColor = [NSColor colorWithCalibratedWhite:1.0 alpha:0.10];
	card.elizaCornerRadius = 10.0;
	NSRect tagFrame = [tag frame];
	tagFrame.origin = NSMakePoint(pad, pad);
	[tag setFrame:tagFrame];
	[card addSubview:tag];
	if (body != nil) {
		NSRect bodyFrame = [body frame];
		bodyFrame.origin =
			NSMakePoint(pad, pad + [tag frame].size.height + 4.0);
		[body setFrame:bodyFrame];
		[card addSubview:body];
	}
	elizaTranscriptAppend(doc, card, x, y);
}

static NSString *elizaTranscriptWidgetSummary(NSString *widgetKind,
											  NSDictionary *data) {
	if ([widgetKind isEqualToString:@"form"]) {
		NSDictionary *form = elizaTranscriptDict(data[@"form"]);
		NSString *title = elizaTranscriptString(form[@"title"]);
		NSUInteger fields = [elizaTranscriptArray(form[@"fields"]) count];
		return [NSString stringWithFormat:@"%@ — %lu fields", title,
										  (unsigned long)fields];
	}
	if ([widgetKind isEqualToString:@"workflow"]) {
		NSDictionary *workflow = elizaTranscriptDict(data[@"workflow"]);
		NSString *title = elizaTranscriptString(workflow[@"title"]);
		NSArray *steps = elizaTranscriptArray(workflow[@"steps"]);
		NSMutableArray<NSString *> *parts = [NSMutableArray array];
		for (id rawStep in steps) {
			NSDictionary *step = elizaTranscriptDict(rawStep);
			if (step == nil) {
				continue;
			}
			[parts addObject:[NSString
				stringWithFormat:@"%@ (%@)",
								 elizaTranscriptString(step[@"label"]),
								 elizaTranscriptString(step[@"status"])]];
		}
		return [NSString stringWithFormat:@"%@ — %@", title,
										  [parts componentsJoinedByString:@" · "]];
	}
	if ([widgetKind isEqualToString:@"checklist"]) {
		NSDictionary *checklist = elizaTranscriptDict(data[@"checklist"]);
		NSString *title = elizaTranscriptString(checklist[@"title"]);
		NSUInteger items = [elizaTranscriptArray(checklist[@"items"]) count];
		return [NSString stringWithFormat:@"%@ — %lu items", title,
										  (unsigned long)items];
	}
	if ([widgetKind isEqualToString:@"task"]) {
		return elizaTranscriptString(data[@"title"]);
	}
	return @"";
}

static void elizaTranscriptAppendWidget(NSView *doc, NSDictionary *segment,
										CGFloat x, CGFloat width, CGFloat *y) {
	NSString *widgetKind = elizaTranscriptString(segment[@"widgetKind"]);
	NSDictionary *data = elizaTranscriptDict(segment[@"data"]);

	if ([widgetKind isEqualToString:@"choice"]) {
		// Interactive: a tap enqueues the option's exact value string — the
		// same payload the DOM choice widget passes to sendActionMessage.
		NSMutableArray<NSButton *> *chips = [NSMutableArray array];
		for (id rawOption in elizaTranscriptArray(data[@"options"])) {
			NSDictionary *option = elizaTranscriptDict(rawOption);
			NSString *label = elizaTranscriptString(option[@"label"]);
			NSString *value = elizaTranscriptString(option[@"value"]);
			if ([label length] == 0 || [value length] == 0) {
				continue;
			}
			[chips addObject:elizaTranscriptChipButton(label, value, YES)];
		}
		if ([chips count] > 0) {
			elizaTranscriptAppendChips(doc, chips, x, width, y);
			return;
		}
	}

	if ([widgetKind isEqualToString:@"followups"]) {
		// `reply` chips send their payload on the action channel (DOM parity);
		// `prompt`/`navigate` need composer/router hooks — passive in the spike.
		NSMutableArray<NSButton *> *chips = [NSMutableArray array];
		for (id rawOption in elizaTranscriptArray(data[@"options"])) {
			NSDictionary *option = elizaTranscriptDict(rawOption);
			NSString *kind = elizaTranscriptString(option[@"kind"]);
			NSString *label = elizaTranscriptString(option[@"label"]);
			NSString *payload = elizaTranscriptString(option[@"payload"]);
			if ([label length] == 0) {
				continue;
			}
			BOOL isReply = [kind isEqualToString:@"reply"];
			[chips addObject:elizaTranscriptChipButton(
								 label, isReply ? payload : @"", NO)];
		}
		if ([chips count] > 0) {
			elizaTranscriptAppendChips(doc, chips, x, width, y);
			return;
		}
	}

	NSString *kindLabel = [widgetKind length] > 0 ? widgetKind : @"widget";
	elizaTranscriptAppendPlaceholder(
		doc, kindLabel, elizaTranscriptWidgetSummary(widgetKind, data), x,
		width, y);
}

static void elizaTranscriptAppendPermission(NSView *doc, NSDictionary *segment,
											CGFloat x, CGFloat width,
											CGFloat *y) {
	NSDictionary *payload = elizaTranscriptDict(segment[@"payload"]);
	NSString *permission = elizaTranscriptString(payload[@"permission"]);
	NSString *reason = elizaTranscriptString(payload[@"reason"]);
	NSString *feature = elizaTranscriptString(payload[@"feature"]);
	elizaTranscriptAppendPlaceholder(
		doc,
		[NSString stringWithFormat:@"permission · %@", permission], reason, x,
		width, y);
	// The documented action-string protocol from spec.ts, verbatim.
	NSMutableArray<NSButton *> *chips = [NSMutableArray array];
	[chips addObject:elizaTranscriptChipButton(
						 @"Grant",
						 [NSString stringWithFormat:
							  @"__permission_card__:granted feature=%@ permission=%@",
							  feature, permission],
						 YES)];
	BOOL fallbackOffered =
		[payload[@"fallbackOffered"] isKindOfClass:[NSNumber class]] &&
		[payload[@"fallbackOffered"] boolValue];
	if (fallbackOffered) {
		[chips addObject:elizaTranscriptChipButton(
							 @"Use fallback",
							 [NSString stringWithFormat:
								  @"__permission_card__:use_fallback feature=%@ permission=%@",
								  feature, permission],
							 NO)];
	}
	elizaTranscriptAppendChips(doc, chips, x, width, y);
}

static void elizaTranscriptAppendSegment(NSView *doc, NSDictionary *segment,
										 BOOL isUser, CGFloat width,
										 CGFloat *y) {
	NSString *kind = elizaTranscriptString(segment[@"kind"]);
	CGFloat x = kElizaTranscriptPadding;
	CGFloat contentWidth = width - kElizaTranscriptPadding * 2.0;

	if ([kind isEqualToString:@"text"]) {
		NSString *text = [elizaTranscriptString(segment[@"text"])
			stringByTrimmingCharactersInSet:
				[NSCharacterSet whitespaceAndNewlineCharacterSet]];
		if ([text length] == 0) {
			return;
		}
		if (isUser) {
			// Right-aligned dark chip, max 72% width.
			const CGFloat pad = 11.0;
			CGFloat maxChip = contentWidth * 0.72 - pad * 2.0;
			NSTextField *body = elizaTranscriptLabel(
				elizaTranscriptBody(text, elizaTranscriptPrimaryTextColor(),
									13.0),
				maxChip);
			NSSize bodySize = [body frame].size;
			ElizaTranscriptCardView *chip = [[ElizaTranscriptCardView alloc]
				initWithFrame:NSMakeRect(0, 0, bodySize.width + pad * 2.0,
										 bodySize.height + pad * 2.0 - 4.0)];
			chip.elizaFillColor =
				[NSColor colorWithCalibratedWhite:0.06 alpha:0.72];
			chip.elizaStrokeColor =
				[NSColor colorWithCalibratedWhite:1.0 alpha:0.10];
			chip.elizaCornerRadius = 14.0;
			NSRect bodyFrame = [body frame];
			bodyFrame.origin = NSMakePoint(pad, pad - 2.0);
			[body setFrame:bodyFrame];
			[chip addSubview:body];
			CGFloat chipX =
				width - kElizaTranscriptPadding - [chip frame].size.width;
			elizaTranscriptAppend(doc, chip, chipX, y);
		} else {
			NSTextField *body = elizaTranscriptLabel(
				elizaTranscriptBody(text, elizaTranscriptPrimaryTextColor(),
									13.0),
				contentWidth);
			elizaTranscriptAppend(doc, body, x, y);
		}
		return;
	}
	if ([kind isEqualToString:@"code"]) {
		BOOL inline_ = [segment[@"inline"] isKindOfClass:[NSNumber class]] &&
					   [segment[@"inline"] boolValue];
		if (inline_) {
			NSTextField *body = elizaTranscriptLabel(
				elizaTranscriptMonoText(elizaTranscriptString(segment[@"code"]),
										elizaTranscriptPrimaryTextColor(),
										12.0),
				contentWidth);
			elizaTranscriptAppend(doc, body, x, y);
		} else {
			elizaTranscriptAppendCode(doc, segment, x, contentWidth, y);
		}
		return;
	}
	if ([kind isEqualToString:@"widget"]) {
		elizaTranscriptAppendWidget(doc, segment, x, contentWidth, y);
		return;
	}
	if ([kind isEqualToString:@"permission"]) {
		elizaTranscriptAppendPermission(doc, segment, x, contentWidth, y);
		return;
	}
	if ([kind isEqualToString:@"ui-spec"]) {
		NSString *raw = elizaTranscriptString(segment[@"raw"]);
		NSString *summary = @"generated interface";
		NSData *rawData = [raw dataUsingEncoding:NSUTF8StringEncoding];
		if (rawData != nil) {
			NSDictionary *spec = elizaTranscriptDict([NSJSONSerialization
				JSONObjectWithData:rawData
						   options:0
							 error:nil]);
			NSString *root = elizaTranscriptString(spec[@"root"]);
			if ([root length] > 0) {
				summary = [NSString
					stringWithFormat:@"generated interface · root %@", root];
			}
		}
		elizaTranscriptAppendPlaceholder(doc, @"ui-spec", summary, x,
										 contentWidth, y);
		return;
	}
	if ([kind isEqualToString:@"config"]) {
		elizaTranscriptAppendPlaceholder(
			doc, @"config", elizaTranscriptString(segment[@"pluginId"]), x,
			contentWidth, y);
		return;
	}
	// Unknown kinds still render — tolerant decoding is part of the contract.
	elizaTranscriptAppendPlaceholder(doc, kind, @"", x, contentWidth, y);
}

static void elizaTranscriptAppendMessage(NSView *doc, NSDictionary *message,
										 CGFloat width, CGFloat *y) {
	NSString *role = elizaTranscriptString(message[@"role"]);
	BOOL isUser = [role isEqualToString:@"user"];
	CGFloat x = kElizaTranscriptPadding;
	CGFloat contentWidth = width - kElizaTranscriptPadding * 2.0;

	// Side-channel order mirrors the DOM renderer (MessageContent.tsx):
	// reasoning, then tool events, then segments, then the failure row.
	NSString *reasoning = elizaTranscriptString(message[@"reasoning"]);
	if (!isUser && [reasoning length] > 0) {
		NSString *oneLine = [[reasoning
			componentsSeparatedByCharactersInSet:[NSCharacterSet
													 newlineCharacterSet]]
			firstObject];
		NSTextField *row = elizaTranscriptSingleLineLabel(
			elizaTranscriptBody(
				[NSString stringWithFormat:@"Thinking ▸ %@", oneLine],
				elizaTranscriptFaintTextColor(), 11.0),
			contentWidth);
		elizaTranscriptAppend(doc, row, x, y);
	}

	for (id rawEvent in elizaTranscriptArray(message[@"toolEvents"])) {
		NSDictionary *event = elizaTranscriptDict(rawEvent);
		if (event == nil) {
			continue;
		}
		NSString *status = elizaTranscriptString(event[@"status"]);
		BOOL running = [status isEqualToString:@"running"];
		NSString *duration = @"";
		if ([event[@"durationMs"] isKindOfClass:[NSNumber class]]) {
			duration = [NSString
				stringWithFormat:@" · %.0fms",
								 [event[@"durationMs"] doubleValue]];
		}
		NSMutableAttributedString *row =
			[[NSMutableAttributedString alloc] init];
		[row appendAttributedString:[[NSAttributedString alloc]
			initWithString:@"● "
				attributes:@{
					NSFontAttributeName : [NSFont systemFontOfSize:9.0],
					NSForegroundColorAttributeName :
						running ? elizaTranscriptAccentColor()
								: elizaTranscriptFaintTextColor(),
				}]];
		[row appendAttributedString:[[NSAttributedString alloc]
			initWithString:[NSString stringWithFormat:@"%@ — %@%@",
							elizaTranscriptString(event[@"actionName"]),
							status, duration]
				attributes:@{
					NSFontAttributeName : [NSFont
						monospacedSystemFontOfSize:10.5
											weight:NSFontWeightRegular],
					NSForegroundColorAttributeName :
						elizaTranscriptDimTextColor(),
				}]];
		elizaTranscriptAppend(
			doc, elizaTranscriptSingleLineLabel(row, contentWidth), x, y);
	}

	for (id rawSegment in elizaTranscriptArray(message[@"segments"])) {
		NSDictionary *segment = elizaTranscriptDict(rawSegment);
		if (segment == nil) {
			continue;
		}
		elizaTranscriptAppendSegment(doc, segment, isUser, width, y);
	}

	NSDictionary *secretRequest =
		elizaTranscriptDict(message[@"secretRequest"]);
	if (secretRequest != nil) {
		elizaTranscriptAppendPlaceholder(
			doc,
			[NSString stringWithFormat:@"secret · %@",
				elizaTranscriptString(secretRequest[@"key"])],
			elizaTranscriptString(secretRequest[@"reason"]), x, contentWidth,
			y);
	}

	NSString *failureKind = elizaTranscriptString(message[@"failureKind"]);
	if ([failureKind length] > 0) {
		NSTextField *row = elizaTranscriptSingleLineLabel(
			elizaTranscriptBody(
				[NSString stringWithFormat:@"⚠ Turn failed (%@) — retry from the composer",
										   failureKind],
				elizaTranscriptAccentColor(), 11.5),
			contentWidth);
		elizaTranscriptAppend(doc, row, x, y);
	}

	BOOL streaming = [message[@"streaming"] isKindOfClass:[NSNumber class]] &&
					 [message[@"streaming"] boolValue];
	if (streaming) {
		NSTextField *row = elizaTranscriptSingleLineLabel(
			elizaTranscriptBody(@"…", elizaTranscriptAccentColor(), 13.0),
			contentWidth);
		elizaTranscriptAppend(doc, row, x, y);
	}

	*y += kElizaTranscriptTurnGap - kElizaTranscriptRowGap;
}

static NSView *elizaTranscriptBuildDocument(NSDictionary *frame,
											CGFloat width) {
	ElizaTranscriptDocumentView *doc = [[ElizaTranscriptDocumentView alloc]
		initWithFrame:NSMakeRect(0, 0, width, 0)];
	CGFloat y = kElizaTranscriptPadding;

	NSString *schema = elizaTranscriptString(frame[@"schema"]);
	if (![schema isEqualToString:@"eliza.native-transcript/v1"]) {
		// Wrong/missing schema renders an explicit error row, never a crash
		// and never a silently-empty transcript.
		NSTextField *row = elizaTranscriptLabel(
			elizaTranscriptBody(
				[NSString stringWithFormat:
					 @"Unsupported transcript frame (schema: %@)",
					 [schema length] > 0 ? schema : @"missing"],
				elizaTranscriptAccentColor(), 12.0),
			width - kElizaTranscriptPadding * 2.0);
		elizaTranscriptAppend(doc, row, kElizaTranscriptPadding, &y);
	} else {
		for (id rawMessage in elizaTranscriptArray(frame[@"messages"])) {
			NSDictionary *message = elizaTranscriptDict(rawMessage);
			if (message == nil) {
				continue;
			}
			elizaTranscriptAppendMessage(doc, message, width, &y);
		}
		NSDictionary *turnStatus = elizaTranscriptDict(frame[@"turnStatus"]);
		if (turnStatus != nil) {
			NSString *label = elizaTranscriptString(turnStatus[@"label"]);
			NSString *kind = elizaTranscriptString(turnStatus[@"kind"]);
			NSTextField *row = elizaTranscriptSingleLineLabel(
				elizaTranscriptBody(
					[NSString stringWithFormat:@"● %@",
						[label length] > 0 ? label : kind],
					elizaTranscriptAccentColor(), 11.0),
				width - kElizaTranscriptPadding * 2.0);
			elizaTranscriptAppend(doc, row, kElizaTranscriptPadding, &y);
		}
	}

	NSRect docFrame = [doc frame];
	docFrame.size.height = y + kElizaTranscriptPadding;
	[doc setFrame:docFrame];
	return doc;
}

static NSScrollView *elizaTranscriptFindScrollView(NSView *contentView) {
	for (NSView *subview in [contentView subviews]) {
		if ([subview isKindOfClass:[NSScrollView class]] &&
			[[subview identifier]
				isEqualToString:kElizaNativeTranscriptScrollIdentifier]) {
			return (NSScrollView *)subview;
		}
	}
	return nil;
}

static void elizaTranscriptFillScrollView(NSScrollView *scrollView,
										  NSDictionary *frame) {
	CGFloat width = [scrollView bounds].size.width;
	NSView *doc = elizaTranscriptBuildDocument(frame, width);
	[scrollView setDocumentView:doc];
	// Latest turn visible: flipped document, so the bottom is max-y.
	[doc scrollPoint:NSMakePoint(0, [doc frame].size.height)];
}

// ---------------------------------------------------------------------------
// extern "C" FFI surface
// ---------------------------------------------------------------------------

/**
 * Decode `frameJson` (eliza.native-transcript/v1) and mount/refresh the native
 * transcript list over the window's content at the given rect. Coordinates are
 * CSS-pixel-style: origin top-left of the content view. Idempotent — repeated
 * calls re-frame and re-render in place.
 */
extern "C" bool transcriptShow(void *windowPtr, const char *frameJson,
							   double x, double y, double w, double h) {
	if (windowPtr == nullptr || frameJson == nullptr) {
		return false;
	}
	NSString *json = [NSString stringWithUTF8String:frameJson];
	if (json == nil) {
		return false;
	}
	NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
	NSDictionary *frame = data != nil
		? elizaTranscriptDict([NSJSONSerialization JSONObjectWithData:data
															  options:0
																error:nil])
		: nil;
	if (frame == nil) {
		return false;
	}

	__block BOOL success = NO;
	elizaTranscriptRunOnMain(^{
		NSWindow *window = (__bridge NSWindow *)windowPtr;
		if (![window isKindOfClass:[NSWindow class]]) {
			return;
		}
		NSView *contentView = [window contentView];
		if (contentView == nil) {
			return;
		}
		CGFloat contentHeight = [contentView bounds].size.height;
		NSRect targetFrame = [contentView isFlipped]
			? NSMakeRect(x, y, w, h)
			: NSMakeRect(x, contentHeight - y - h, w, h);

		NSScrollView *scrollView = elizaTranscriptFindScrollView(contentView);
		if (scrollView == nil) {
			scrollView = [[NSScrollView alloc] initWithFrame:targetFrame];
			[scrollView setIdentifier:kElizaNativeTranscriptScrollIdentifier];
			[scrollView setDrawsBackground:NO];
			[scrollView setBorderType:NSNoBorder];
			[scrollView setHasVerticalScroller:YES];
			[scrollView setScrollerStyle:NSScrollerStyleOverlay];
			// Explicit frames from show(); autoresize would double-apply with
			// the host's own reposition calls (resize-strip convention).
			[scrollView setAutoresizingMask:NSViewNotSizable];
			// Above the WKWebView — the native transcript replaces the DOM
			// transcript region while mounted.
			[contentView addSubview:scrollView
						 positioned:NSWindowAbove
						 relativeTo:nil];
		} else {
			[scrollView setFrame:targetFrame];
		}
		elizaTranscriptFillScrollView(scrollView, frame);
		success = YES;
	});
	return success;
}

/** Replace the transcript content while mounted (frame-diffing is a follow-up;
 *  the spike rebuilds). No-op false when the view is not mounted. */
extern "C" bool transcriptSetTranscript(void *windowPtr,
										const char *frameJson) {
	if (windowPtr == nullptr || frameJson == nullptr) {
		return false;
	}
	NSString *json = [NSString stringWithUTF8String:frameJson];
	NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
	NSDictionary *frame = data != nil
		? elizaTranscriptDict([NSJSONSerialization JSONObjectWithData:data
															  options:0
																error:nil])
		: nil;
	if (frame == nil) {
		return false;
	}
	__block BOOL success = NO;
	elizaTranscriptRunOnMain(^{
		NSWindow *window = (__bridge NSWindow *)windowPtr;
		if (![window isKindOfClass:[NSWindow class]]) {
			return;
		}
		NSScrollView *scrollView =
			elizaTranscriptFindScrollView([window contentView]);
		if (scrollView == nil) {
			return;
		}
		elizaTranscriptFillScrollView(scrollView, frame);
		success = YES;
	});
	return success;
}

extern "C" bool transcriptHide(void *windowPtr) {
	if (windowPtr == nullptr) {
		return false;
	}
	__block BOOL success = NO;
	elizaTranscriptRunOnMain(^{
		NSWindow *window = (__bridge NSWindow *)windowPtr;
		if (![window isKindOfClass:[NSWindow class]]) {
			return;
		}
		NSScrollView *scrollView =
			elizaTranscriptFindScrollView([window contentView]);
		if (scrollView != nil) {
			[scrollView removeFromSuperview];
		}
		success = YES;
	});
	return success;
}

/**
 * Drain one pending widget-action string (FIFO). Returns a malloc'd UTF-8
 * copy the caller must release via transcriptFreeCString, or NULL when the
 * queue is empty. Poll-based by design: bun:ffi C-callback support is the
 * fragile path, and window-effects.mm already established polling
 * (elizaOnboardingGetChoice) as this dylib layer's native→JS channel.
 */
extern "C" char *transcriptTakePendingAction(void) {
	NSMutableArray<NSString *> *queue = elizaTranscriptPendingActions();
	NSString *next = nil;
	@synchronized(queue) {
		if ([queue count] > 0) {
			next = [queue objectAtIndex:0];
			[queue removeObjectAtIndex:0];
		}
	}
	if (next == nil) {
		return nullptr;
	}
	const char *utf8 = [next UTF8String];
	if (utf8 == nullptr) {
		return nullptr;
	}
	size_t len = strlen(utf8);
	char *out = (char *)malloc(len + 1);
	if (out == nullptr) {
		return nullptr;
	}
	memcpy(out, utf8, len + 1);
	return out;
}

extern "C" void transcriptFreeCString(char *value) {
	if (value != nullptr) {
		free(value);
	}
}

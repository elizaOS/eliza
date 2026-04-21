#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AVFoundation/AVFoundation.h>
#import <Availability.h>
#import <CoreGraphics/CoreGraphics.h>

static NSString *const kElectrobunVibrancyViewIdentifier =
	@"ElectrobunVibrancyView";
static NSString *const kElectrobunNativeDragViewIdentifier =
	@"ElectrobunNativeDragView";
static NSString *const kElectrobunNativeDragRightEdgeIdentifier =
	@"ElectrobunNativeDragRightEdge";
static NSString *const kElizaInactiveTrafficLightsOverlayIdentifier =
	@"ElizaInactiveTrafficLightsOverlay";

/** Transparent strip for moving the window. WKWebView does not honor
 *  -webkit-app-region reliably on system WebKit; this view is stacked
 *  NSWindowAbove the web view so clicks hit AppKit first. It passes through
 *  known titlebar control zones so React buttons still receive clicks. */
@interface ElectrobunNativeDragView : NSView
@property(nonatomic, copy) NSArray<NSValue *> *passthroughRects;
@end

@implementation ElectrobunNativeDragView
- (BOOL)isOpaque {
	return NO;
}

- (void)drawRect:(NSRect)dirtyRect {
	(void)dirtyRect;
}

- (nullable NSView *)hitTest:(NSPoint)point {
	for (NSValue *value in self.passthroughRects) {
		if (NSPointInRect(point, [value rectValue])) {
			return nil;
		}
	}
	return [super hitTest:point];
}

- (void)mouseDown:(NSEvent *)event {
	NSWindow *window = [self window];
	if (window != nil && event != nil) {
		// Standard API for dragging from client-area views (hiddenInset).
		[window performWindowDragWithEvent:event];
	}
}
@end

@interface ElizaInactiveTrafficLightsOverlayView : NSView
@property(nonatomic, copy) NSArray<NSValue *> *dotRects;
@end

@implementation ElizaInactiveTrafficLightsOverlayView
- (BOOL)isOpaque {
	return NO;
}

- (nullable NSView *)hitTest:(NSPoint)point {
	(void)point;
	return nil;
}

- (void)drawRect:(NSRect)dirtyRect {
	(void)dirtyRect;
	NSColor *fill = [NSColor colorWithCalibratedWhite:0.62 alpha:0.72];
	NSColor *stroke = [NSColor colorWithCalibratedWhite:0.42 alpha:0.32];
	for (NSValue *value in self.dotRects) {
		NSRect rect = [value rectValue];
		CGFloat diameter = MIN(MIN(rect.size.width, rect.size.height), 12.0);
		NSRect dot = NSMakeRect(NSMidX(rect) - diameter / 2.0,
								NSMidY(rect) - diameter / 2.0,
								diameter,
								diameter);
		NSBezierPath *path = [NSBezierPath bezierPathWithOvalInRect:dot];
		[fill setFill];
		[path fill];
		[stroke setStroke];
		[path setLineWidth:0.5];
		[path stroke];
	}
}
@end

static NSString *const kElizaResizeStripRightIdentifier =
	@"ElizaResizeStripRight";
static NSString *const kElizaResizeStripBottomIdentifier =
	@"ElizaResizeStripBottom";
static NSString *const kElizaResizeStripCornerIdentifier =
	@"ElizaResizeStripCorner";

typedef NS_ENUM(NSInteger, ElizaResizeStripKind) {
	ElizaResizeStripKindRightEdge = 0,
	ElizaResizeStripKindBottomEdge = 1,
	ElizaResizeStripKindBottomRightCorner = 2,
};

/**
 * Invisible views stacked above WKWebView.
 *
 * WHY overlays: WebKit drives the cursor for page content. NSTrackingArea on the
 * contentView *below* the web view loses hit testing and cursorUpdate: for the
 * resize bands. Prior approaches (local mouseMoved monitor + deferred [NSCursor
 * set]) flickered because WebKit immediately overwrote the cursor.
 *
 * WHY resetCursorRects: For views that actually receive the pointer, AppKit
 * applies cursor rects without fighting the web process.
 *
 * WHY mouseDown resize loop: Inner-edge resize must work where the web view
 * would otherwise swallow events; the loop adjusts window frame from screen
 * mouse deltas until mouse up (clamped to min/max size).
 */
@interface ElizaResizeStripView : NSView
@property (nonatomic, assign) ElizaResizeStripKind elizaKind;
@end

static void elizaRunWindowResizeLoop(NSWindow *window,
									  ElizaResizeStripKind kind);

@implementation ElizaResizeStripView

- (BOOL)isOpaque {
	return NO;
}

- (void)drawRect:(NSRect)dirtyRect {
	(void)dirtyRect;
}

- (nullable NSCursor *)elizaCursorForKind {
	switch (self.elizaKind) {
		case ElizaResizeStripKindBottomRightCorner:
			// GitHub's macOS builders may use a pre-15 AppKit SDK where the new
			// frame resize cursor API is not declared yet.
#if defined(MAC_OS_VERSION_15_0) &&                                      \
	defined(__MAC_OS_X_VERSION_MAX_ALLOWED) &&                           \
	__MAC_OS_X_VERSION_MAX_ALLOWED >= MAC_OS_VERSION_15_0
			if (@available(macOS 15.0, *)) {
				return [NSCursor
					frameResizeCursorFromPosition:
						NSCursorFrameResizePositionBottomRight
									 inDirections:
						 NSCursorFrameResizeDirectionsAll];
			}
#endif
			return [NSCursor crosshairCursor];
		case ElizaResizeStripKindRightEdge:
			return [NSCursor resizeLeftRightCursor];
		case ElizaResizeStripKindBottomEdge:
			return [NSCursor resizeUpDownCursor];
	}
	return nil;
}

- (void)resetCursorRects {
	[super resetCursorRects];
	NSCursor *c = [self elizaCursorForKind];
	if (c != nil) {
		[self addCursorRect:[self bounds] cursor:c];
	}
}

- (void)mouseDown:(NSEvent *)event {
	(void)event;
	NSWindow *w = [self window];
	elizaRunWindowResizeLoop(w, self.elizaKind);
}

@end

static void elizaRunWindowResizeLoop(NSWindow *window,
									  ElizaResizeStripKind kind) {
	if (window == nil) {
		return;
	}
	NSRect startFrame = [window frame];
	NSPoint startMouse = [NSEvent mouseLocation];
	NSSize minSz = [window minSize];
	NSSize maxSz = [window maxSize];
	CGFloat minW = minSz.width > 1.0 ? minSz.width : 100.0;
	CGFloat minH = minSz.height > 1.0 ? minSz.height : 100.0;
	CGFloat maxW = maxSz.width > 0.0 ? maxSz.width : 100000.0;
	CGFloat maxH = maxSz.height > 0.0 ? maxSz.height : 100000.0;
	maxW = MAX(maxW, minW);
	maxH = MAX(maxH, minH);

	while (YES) {
		NSEvent *e = [window
			nextEventMatchingMask:(NSEventMaskLeftMouseDragged |
								   NSEventMaskLeftMouseUp)];
		if ([e type] == NSEventTypeLeftMouseUp) {
			break;
		}
		NSPoint mouse = [NSEvent mouseLocation];
		CGFloat deltaX = mouse.x - startMouse.x;
		// NSEvent mouseLocation Y increases upward; dragging “down” grows height.
		CGFloat deltaY = startMouse.y - mouse.y;

		NSRect fr = startFrame;
		switch (kind) {
			case ElizaResizeStripKindRightEdge: {
				CGFloat w = startFrame.size.width + deltaX;
				fr.size.width = MAX(minW, MIN(maxW, w));
				break;
			}
			case ElizaResizeStripKindBottomEdge: {
				CGFloat h = startFrame.size.height + deltaY;
				fr.size.height = MAX(minH, MIN(maxH, h));
				fr.origin.y = startFrame.origin.y -
							  (fr.size.height - startFrame.size.height);
				break;
			}
			case ElizaResizeStripKindBottomRightCorner: {
				CGFloat w = startFrame.size.width + deltaX;
				CGFloat h = startFrame.size.height + deltaY;
				fr.size.width = MAX(minW, MIN(maxW, w));
				fr.size.height = MAX(minH, MIN(maxH, h));
				fr.origin.y = startFrame.origin.y -
							  (fr.size.height - startFrame.size.height);
				break;
			}
		}
		[window setFrame:fr display:YES];
	}
}

static ElizaResizeStripView *elizaFindResizeStrip(NSView *contentView,
													NSString *identifier) {
	if (contentView == nil || identifier == nil) {
		return nil;
	}
	for (NSView *sv in [contentView subviews]) {
		if ([sv isKindOfClass:[ElizaResizeStripView class]] &&
			[[sv identifier] isEqualToString:identifier]) {
			return (ElizaResizeStripView *)sv;
		}
	}
	return nil;
}

static ElizaResizeStripView *elizaEnsureResizeStrip(NSView *contentView,
													  NSString *identifier) {
	ElizaResizeStripView *v = elizaFindResizeStrip(contentView, identifier);
	if (v == nil) {
		v = [[ElizaResizeStripView alloc] initWithFrame:NSZeroRect];
		[v setIdentifier:identifier];
	}
	return v;
}

/** Removes strips when the window is too small for rb geometry so we never
 *  leave stale hit targets with zero/invalid frames. */
static void elizaRemoveResizeStripOverlays(NSView *contentView) {
	if (contentView == nil) {
		return;
	}
	NSArray<NSString *> *idents = @[
		kElizaResizeStripBottomIdentifier,
		kElizaResizeStripRightIdentifier,
		kElizaResizeStripCornerIdentifier,
	];
	for (NSString *ident in idents) {
		ElizaResizeStripView *v = elizaFindResizeStrip(contentView, ident);
		if (v != nil) {
			[v removeFromSuperview];
		}
	}
}

/** Positions right/bottom/BR strips; z-order: below dragView, corner above
 *  right above bottom so BR gets diagonal hit testing. */
static void elizaInstallResizeStripOverlays(NSWindow *window,
											 NSView *contentView,
											 CGFloat chromeDepth,
											 ElectrobunNativeDragView *dragView) {
	if (window == nil || contentView == nil || dragView == nil) {
		return;
	}

	const CGFloat rb = chromeDepth;
	const CGFloat topExcl = chromeDepth;
	CGFloat W = contentView.bounds.size.width;
	CGFloat H = contentView.bounds.size.height;
	if (W < rb * 3.0 || H < topExcl + rb + 4.0) {
		elizaRemoveResizeStripOverlays(contentView);
		return;
	}

	BOOL flipped = [contentView isFlipped];

	ElizaResizeStripView *bottom =
		elizaEnsureResizeStrip(contentView, kElizaResizeStripBottomIdentifier);
	ElizaResizeStripView *right =
		elizaEnsureResizeStrip(contentView, kElizaResizeStripRightIdentifier);
	ElizaResizeStripView *corner =
		elizaEnsureResizeStrip(contentView, kElizaResizeStripCornerIdentifier);

	bottom.elizaKind = ElizaResizeStripKindBottomEdge;
	right.elizaKind = ElizaResizeStripKindRightEdge;
	corner.elizaKind = ElizaResizeStripKindBottomRightCorner;

	// Frames set explicitly when setNativeWindowDragRegion runs from TS (resize,
	// move, dom-ready). Autoresizing would double-apply with contentView bounds.
	[bottom setAutoresizingMask:NSViewNotSizable];
	[right setAutoresizingMask:NSViewNotSizable];
	[corner setAutoresizingMask:NSViewNotSizable];

	NSRect bottomR;
	NSRect rightR;
	NSRect cornerR;
	if (flipped) {
		bottomR = NSMakeRect(rb, H - rb, W - 2.0 * rb, rb);
		rightR = NSMakeRect(W - rb, topExcl, rb, H - topExcl - rb);
		cornerR = NSMakeRect(W - rb, H - rb, rb, rb);
	} else {
		bottomR = NSMakeRect(rb, 0.0, W - 2.0 * rb, rb);
		rightR = NSMakeRect(W - rb, rb, rb, H - topExcl - rb);
		cornerR = NSMakeRect(W - rb, 0.0, rb, rb);
	}

	[bottom setFrame:bottomR];
	[right setFrame:rightR];
	[corner setFrame:cornerR];

	// Back -> front among strips: bottom, right, corner (corner wins at BR).
	[contentView addSubview:bottom
				 positioned:NSWindowBelow
				 relativeTo:dragView];
	[contentView addSubview:right
				 positioned:NSWindowAbove
				 relativeTo:bottom];
	[contentView addSubview:corner
				 positioned:NSWindowAbove
				 relativeTo:right];

	[window invalidateCursorRectsForView:bottom];
	[window invalidateCursorRectsForView:right];
	[window invalidateCursorRectsForView:corner];
}

/// Inside-facing drag + resize band thickness (points).
/// WHY auto: one constant looks wrong on 1x vs 2x and on very wide displays.
/// `hostHeightHint` > 0.5 pins thickness (debug / product override).
static CGFloat elizaChromeDepthPoints(NSWindow *window, double hostHeightHint) {
	if (hostHeightHint > 0.5) {
		return MAX(12.0, MIN(48.0, (CGFloat)hostHeightHint));
	}

	NSScreen *s = window.screen;
	if (s == nil) {
		s = [NSScreen mainScreen];
	}
	if (s == nil) {
		return 26.0;
	}

	CGFloat scale = MAX(1.0, s.backingScaleFactor);
	// ~20pt @1x -> ~27pt @2x (similar physical hit target on Retina).
	CGFloat d = 20.0 + 7.0 * (scale - 1.0);

	const CGFloat vw = NSWidth(s.visibleFrame);
	if (vw >= 2200.0) {
		d += 2.0;
	}
	if (vw >= 3000.0) {
		d += 2.0;
	}

	return MAX(18.0, MIN(38.0, round(d)));
}

static NSArray<NSValue *> *elizaTitlebarDragPassthroughRects(CGFloat width,
															 CGFloat height) {
	NSMutableArray<NSValue *> *rects = [NSMutableArray arrayWithCapacity:2];
	const CGFloat leftControlsWidth = width <= 1380.0 ? 280.0 : 640.0;
	const CGFloat rightControlsWidth = 320.0;

	if (leftControlsWidth > 0.0) {
		[rects addObject:[NSValue
							 valueWithRect:NSMakeRect(0.0,
													  0.0,
													  MIN(leftControlsWidth, width),
													  height)]];
	}

	if (width > rightControlsWidth) {
		[rects addObject:[NSValue
							 valueWithRect:NSMakeRect(width - rightControlsWidth,
													  0.0,
													  rightControlsWidth,
													  height)]];
	}

	return rects;
}

static NSVisualEffectView *findVibrancyView(NSView *contentView) {
	for (NSView *subview in [contentView subviews]) {
		if ([subview isKindOfClass:[NSVisualEffectView class]] &&
			[[subview identifier]
				isEqualToString:kElectrobunVibrancyViewIdentifier]) {
			return (NSVisualEffectView *)subview;
		}
	}

	return nil;
}

static ElectrobunNativeDragView *findNativeDragView(NSView *contentView) {
	for (NSView *subview in [contentView subviews]) {
		if ([subview isKindOfClass:[ElectrobunNativeDragView class]] &&
			[[subview identifier]
				isEqualToString:kElectrobunNativeDragViewIdentifier]) {
			return (ElectrobunNativeDragView *)subview;
		}
	}

	return nil;
}

static ElectrobunNativeDragView *findNativeDragRightEdgeView(NSView *contentView) {
	for (NSView *subview in [contentView subviews]) {
		if ([subview isKindOfClass:[ElectrobunNativeDragView class]] &&
			[[subview identifier]
				isEqualToString:kElectrobunNativeDragRightEdgeIdentifier]) {
			return (ElectrobunNativeDragView *)subview;
		}
	}

	return nil;
}

static ElizaInactiveTrafficLightsOverlayView *
findInactiveTrafficLightsOverlay(NSView *container) {
	for (NSView *subview in [container subviews]) {
		if ([subview isKindOfClass:[ElizaInactiveTrafficLightsOverlayView class]] &&
			[[subview identifier]
				isEqualToString:kElizaInactiveTrafficLightsOverlayIdentifier]) {
			return (ElizaInactiveTrafficLightsOverlayView *)subview;
		}
	}

	return nil;
}

static ElizaInactiveTrafficLightsOverlayView *
ensureInactiveTrafficLightsOverlay(NSView *container) {
	ElizaInactiveTrafficLightsOverlayView *overlay =
		findInactiveTrafficLightsOverlay(container);
	if (overlay == nil) {
		overlay = [[ElizaInactiveTrafficLightsOverlayView alloc]
			initWithFrame:NSZeroRect];
		[overlay setIdentifier:kElizaInactiveTrafficLightsOverlayIdentifier];
		[container addSubview:overlay positioned:NSWindowAbove relativeTo:nil];
	}
	return overlay;
}

/**
 * Request accessibility permission with a system prompt.
 * Calls AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: true}),
 * which registers the app in System Preferences -> Accessibility and shows the
 * authorization dialog. Must be called from within the app process.
 * Returns true if already trusted, false if the prompt was shown.
 */
extern "C" bool requestAccessibilityPermission(void) {
	NSDictionary *options = @{(__bridge id)kAXTrustedCheckOptionPrompt: @YES};
	return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

/**
 * Check accessibility trust without prompting.
 */
extern "C" bool checkAccessibilityPermission(void) {
	return AXIsProcessTrusted();
}

/**
 * Request screen recording permission.
 * Calls CGRequestScreenCaptureAccess() which registers the app in
 * System Preferences -> Screen Recording and shows the authorization dialog.
 * Returns true if already granted.
 */
extern "C" bool requestScreenRecordingPermission(void) {
	if (@available(macOS 10.15, *)) {
		return CGRequestScreenCaptureAccess();
	}
	return true;
}

/**
 * Check screen recording permission without prompting.
 */
extern "C" bool checkScreenRecordingPermission(void) {
	if (@available(macOS 10.15, *)) {
		return CGPreflightScreenCaptureAccess();
	}
	return true;
}

/**
 * Check microphone authorization status via AVFoundation (no prompt).
 * Returns: 0=not-determined, 1=denied, 2=granted, 3=restricted
 */
extern "C" int checkMicrophonePermission(void) {
	AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
	switch (status) {
		case AVAuthorizationStatusAuthorized: return 2;
		case AVAuthorizationStatusDenied:     return 1;
		case AVAuthorizationStatusRestricted: return 3;
		default:                              return 0;
	}
}

/**
 * Check camera authorization status via AVFoundation (no prompt).
 * Returns: 0=not-determined, 1=denied, 2=granted, 3=restricted
 */
extern "C" int checkCameraPermission(void) {
	AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
	switch (status) {
		case AVAuthorizationStatusAuthorized: return 2;
		case AVAuthorizationStatusDenied:     return 1;
		case AVAuthorizationStatusRestricted: return 3;
		default:                              return 0;
	}
}

/**
 * Request camera permission via AVFoundation.
 * Calls AVCaptureDevice requestAccessForMediaType which shows the system
 * camera authorization dialog and registers the app.
 */
extern "C" void requestCameraPermission(void) {
	[AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo
	                         completionHandler:^(BOOL granted) {
		(void)granted;
	}];
}

/**
 * Request microphone permission via AVFoundation.
 */
extern "C" void requestMicrophonePermission(void) {
	[AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
	                         completionHandler:^(BOOL granted) {
		(void)granted;
	}];
}

extern "C" bool enableWindowVibrancy(void *windowPtr) {
	if (windowPtr == nullptr) {
		return false;
	}

	__block BOOL success = NO;
	dispatch_sync(dispatch_get_main_queue(), ^{
		NSWindow *window = (__bridge NSWindow *)windowPtr;
		if (![window isKindOfClass:[NSWindow class]]) {
			return;
		}

		[window setOpaque:NO];
		[window setBackgroundColor:[NSColor clearColor]];
		[window setTitlebarAppearsTransparent:YES];
		[window setHasShadow:YES];
		// Helps some clicks in "empty" WKWebView chrome participate in window moves
		// alongside our explicit ElectrobunNativeDragView strips.
		[window setMovableByWindowBackground:YES];

		NSView *contentView = [window contentView];
		if (contentView == nil) {
			return;
		}

		NSVisualEffectView *effectView = findVibrancyView(contentView);

		if (effectView == nil) {
			effectView = [[NSVisualEffectView alloc]
				initWithFrame:[contentView bounds]];
			[effectView setIdentifier:kElectrobunVibrancyViewIdentifier];
			[effectView
				setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
		}

		if (@available(macOS 10.14, *)) {
			[effectView setMaterial:NSVisualEffectMaterialUnderWindowBackground];
		} else {
			[effectView setMaterial:NSVisualEffectMaterialSidebar];
		}
		[effectView setBlendingMode:NSVisualEffectBlendingModeBehindWindow];
		[effectView setState:NSVisualEffectStateActive];

		if ([effectView superview] == nil) {
			NSView *relativeView = [[contentView subviews] firstObject];
			if (relativeView != nil) {
				[contentView addSubview:effectView
							 positioned:NSWindowBelow
							 relativeTo:relativeView];
			} else {
				[contentView addSubview:effectView];
			}
		}

		[window invalidateShadow];
		success = YES;
	});

	return success;
}

extern "C" bool ensureWindowShadow(void *windowPtr) {
	if (windowPtr == nullptr) {
		return false;
	}

	__block BOOL success = NO;
	dispatch_sync(dispatch_get_main_queue(), ^{
		NSWindow *window = (__bridge NSWindow *)windowPtr;
		if (![window isKindOfClass:[NSWindow class]]) {
			return;
		}

		[window setHasShadow:YES];
		[window invalidateShadow];
		success = YES;
	});

	return success;
}

extern "C" bool setWindowTrafficLightsPosition(void *windowPtr, double x,
											   double yFromTop) {
	if (windowPtr == nullptr) {
		return false;
	}

	__block BOOL success = NO;
	dispatch_sync(dispatch_get_main_queue(), ^{
		NSWindow *window = (__bridge NSWindow *)windowPtr;
		if (![window isKindOfClass:[NSWindow class]]) {
			return;
		}

		NSButton *closeButton =
			[window standardWindowButton:NSWindowCloseButton];
		NSButton *minimizeButton =
			[window standardWindowButton:NSWindowMiniaturizeButton];
		NSButton *zoomButton = [window standardWindowButton:NSWindowZoomButton];

		if (closeButton == nil || minimizeButton == nil || zoomButton == nil) {
			return;
		}

		NSView *buttonContainer = [closeButton superview];
		if (buttonContainer == nil) {
			return;
		}

		CGFloat spacing = NSMinX(minimizeButton.frame) - NSMinX(closeButton.frame);
		if (spacing <= 0) {
			spacing = closeButton.frame.size.width + 6.0;
		}

		BOOL inactive = ![NSApp isActive] || ![window isKeyWindow];
		CGFloat buttonAlpha = inactive ? 0.62 : 1.0;
		[buttonContainer setHidden:NO];
		[buttonContainer setAlphaValue:1.0];

		BOOL flipped = [buttonContainer isFlipped];
		CGFloat targetY = yFromTop;
		if (!flipped) {
			targetY = buttonContainer.frame.size.height - yFromTop -
					  closeButton.frame.size.height;
		}
		targetY = MAX(0.0, targetY);

		CGFloat currentX = x;
		NSArray<NSButton *> *buttons = @[ closeButton, minimizeButton, zoomButton ];
		for (NSButton *button in buttons) {
			[button setHidden:NO];
			[button setAlphaValue:buttonAlpha];
			[button setFrameOrigin:NSMakePoint(currentX, targetY)];
			[button setNeedsDisplay:YES];
			currentX += spacing;
		}

		ElizaInactiveTrafficLightsOverlayView *overlay =
			ensureInactiveTrafficLightsOverlay(buttonContainer);
		NSRect overlayFrame =
			NSUnionRect(NSUnionRect(closeButton.frame, minimizeButton.frame),
						zoomButton.frame);
		[overlay setFrame:overlayFrame];
		NSMutableArray<NSValue *> *dotRects = [NSMutableArray arrayWithCapacity:3];
		for (NSButton *button in buttons) {
			NSRect localRect = NSOffsetRect(button.frame,
										   -overlayFrame.origin.x,
										   -overlayFrame.origin.y);
			[dotRects addObject:[NSValue valueWithRect:localRect]];
		}
		[overlay setDotRects:dotRects];
		[overlay setHidden:!inactive];
		[overlay setNeedsDisplay:YES];
		[buttonContainer addSubview:overlay positioned:NSWindowAbove relativeTo:nil];

		[buttonContainer setNeedsLayout:YES];
		[buttonContainer layoutSubtreeIfNeeded];
		[window invalidateShadow];
		success = YES;
	});

	return success;
}

extern "C" bool orderOutWindow(void *windowPtr) {
	if (windowPtr == nullptr) {
		return false;
	}

	__block BOOL success = NO;
	dispatch_sync(dispatch_get_main_queue(), ^{
		NSWindow *window = (__bridge NSWindow *)windowPtr;
		if (![window isKindOfClass:[NSWindow class]]) {
			return;
		}
		[window orderOut:nil];
		success = YES;
	});

	return success;
}

extern "C" bool makeKeyAndOrderFrontWindow(void *windowPtr) {
	if (windowPtr == nullptr) {
		return false;
	}

	__block BOOL success = NO;
	dispatch_sync(dispatch_get_main_queue(), ^{
		NSWindow *window = (__bridge NSWindow *)windowPtr;
		if (![window isKindOfClass:[NSWindow class]]) {
			return;
		}
		if ([window isMiniaturized]) {
			[window deminiaturize:nil];
		}
		[window makeKeyAndOrderFront:nil];
		success = YES;
	});

	return success;
}

extern "C" bool isAppActive(void) {
	__block BOOL result = NO;
	dispatch_sync(dispatch_get_main_queue(), ^{
		result = [NSApp isActive];
	});
	return result;
}

extern "C" bool isWindowKey(void *windowPtr) {
	if (windowPtr == nullptr) {
		return false;
	}

	__block BOOL result = NO;
	dispatch_sync(dispatch_get_main_queue(), ^{
		NSWindow *window = (__bridge NSWindow *)windowPtr;
		if (![window isKindOfClass:[NSWindow class]]) {
			return;
		}
		result = [window isKeyWindow];
	});

	return result;
}

/** Lays out top drag strip + resize overlays (same depth for both).
 *  `height` ≤ 0: derive depth from window.screen (see elizaChromeDepthPoints).
 *  WHY one entry point: TS calls this whenever geometry may have changed so
 *  dragView stays NSWindowAbove WKWebView and strips stay in sync. */
extern "C" bool setNativeWindowDragRegion(void *windowPtr, double x,
										  double height) {
	if (windowPtr == nullptr) {
		return false;
	}

	__block BOOL success = NO;
	dispatch_sync(dispatch_get_main_queue(), ^{
		NSWindow *window = (__bridge NSWindow *)windowPtr;
		if (![window isKindOfClass:[NSWindow class]]) {
			return;
		}

		NSView *contentView = [window contentView];
		if (contentView == nil) {
			return;
		}

		CGFloat dragX = MAX(0.0, x);
		CGFloat dragHeight = elizaChromeDepthPoints(window, height);
		CGFloat resizeDepth = MIN(dragHeight, 12.0);
		CGFloat dragWidth = MAX(0.0, contentView.bounds.size.width - dragX);
		if (dragWidth <= 0.0) {
			return;
		}

		BOOL flipped = [contentView isFlipped];
		CGFloat dragY = flipped ? 0.0 : contentView.bounds.size.height - dragHeight;
		dragY = MAX(0.0, dragY);

		ElectrobunNativeDragView *dragView = findNativeDragView(contentView);
		if (dragView == nil) {
			dragView = [[ElectrobunNativeDragView alloc] initWithFrame:NSZeroRect];
			[dragView setIdentifier:kElectrobunNativeDragViewIdentifier];
		}

		[dragView setFrame:NSMakeRect(dragX, dragY, dragWidth, dragHeight)];
		[dragView
			setPassthroughRects:elizaTitlebarDragPassthroughRects(dragWidth,
																  dragHeight)];
		if (flipped) {
			[dragView setAutoresizingMask:(NSViewWidthSizable | NSViewMinYMargin)];
		} else {
			[dragView setAutoresizingMask:(NSViewWidthSizable | NSViewMaxYMargin)];
		}

		if ([dragView superview] == nil) {
			[contentView addSubview:dragView];
		}
		// Electrobun may insert WKWebView after our first pass -> always re-stack on
		// top so the drag strip is hit-testable (otherwise only a 1px seam works).
		[contentView addSubview:dragView
					 positioned:NSWindowAbove
					 relativeTo:nil];

		// Legacy Electrobun right-edge drag view would steal drags from the resize
		// band; remove so ElizaResizeStripView owns the east edge.
		ElectrobunNativeDragView *legacyRight =
			findNativeDragRightEdgeView(contentView);
		if (legacyRight != nil) {
			[legacyRight removeFromSuperview];
		}

		elizaInstallResizeStripOverlays(window, contentView, resizeDepth, dragView);

		success = YES;
	});

	return success;
}

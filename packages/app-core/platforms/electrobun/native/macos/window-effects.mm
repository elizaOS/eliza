#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AVFoundation/AVFoundation.h>
#import <Availability.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdlib.h>
#include <string.h>

static NSString *const kElectrobunVibrancyViewIdentifier =
	@"ElectrobunVibrancyView";
static NSString *const kElectrobunNativeDragViewIdentifier =
	@"ElectrobunNativeDragView";
static NSString *const kElectrobunNativeDragTitleViewIdentifier =
	@"ElectrobunNativeDragTitleView";
static NSString *const kElectrobunNativeDragRightGapViewIdentifier =
	@"ElectrobunNativeDragRightGapView";
static NSString *const kElectrobunNativeDragRightEdgeIdentifier =
	@"ElectrobunNativeDragRightEdge";
static NSString *const kElizaInactiveTrafficLightsOverlayIdentifier =
	@"ElizaInactiveTrafficLightsOverlay";

static NSMutableArray<NSURL *> *elizaSecurityScopedUrls(void) {
	static NSMutableArray<NSURL *> *urls = nil;
	static dispatch_once_t onceToken;
	dispatch_once(&onceToken, ^{
		urls = [[NSMutableArray alloc] init];
	});
	return urls;
}

static char *elizaCopyCString(NSString *value) {
	if (value == nil) {
		return nullptr;
	}
	const char *utf8 = [value UTF8String];
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

/** Transparent strip for moving the window. WKWebView does not honor
 *  -webkit-app-region reliably on system WebKit; this view is stacked
 *  NSWindowAbove the web view so safe empty/title zones hit AppKit first.
 *  It must never cover titlebar buttons; split views are used for gaps. */
@interface ElectrobunNativeDragView : NSView
@end

@implementation ElectrobunNativeDragView
- (BOOL)isOpaque {
	return NO;
}

- (void)drawRect:(NSRect)dirtyRect {
	(void)dirtyRect;
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
											 NSView *relativeView) {
	if (window == nil || contentView == nil) {
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
	NSWindowOrderingMode bottomOrder =
		relativeView == nil ? NSWindowAbove : NSWindowBelow;
	[contentView addSubview:bottom positioned:bottomOrder relativeTo:relativeView];
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

static NSArray<NSString *> *elizaNativeDragViewIdentifiers(void) {
	return @[
		kElectrobunNativeDragViewIdentifier,
		kElectrobunNativeDragTitleViewIdentifier,
		kElectrobunNativeDragRightGapViewIdentifier,
	];
}

static NSArray<NSValue *> *elizaTitlebarNativeDragRects(CGFloat width,
														CGFloat height,
														BOOL flipped) {
	(void)flipped;
	if (width <= 0.0 || height <= 0.0) {
		return @[];
	}

	NSMutableArray<NSValue *> *rects = [NSMutableArray arrayWithCapacity:3];
	const CGFloat minDragWidth = 56.0;
	const CGFloat minTitleWidth = 96.0;
	const CGFloat leftControlEnd = width <= 1380.0 ? 380.0 : 720.0;
	const CGFloat rightControlsWidth = width <= 860.0 ? 96.0 : 360.0;
	const CGFloat rightControlStart = MAX(leftControlEnd, width - rightControlsWidth);
	if (rightControlStart - leftControlEnd < minTitleWidth) {
		return rects;
	}

	CGFloat titleWidth = MIN(360.0, MAX(160.0, width * 0.24));
	CGFloat titleStart = floor((width - titleWidth) / 2.0);
	CGFloat titleEnd = titleStart + titleWidth;
	titleStart = MAX(titleStart, leftControlEnd);
	titleEnd = MIN(titleEnd, rightControlStart);

	if (titleEnd - titleStart >= minTitleWidth) {
		[rects addObject:[NSValue valueWithRect:NSMakeRect(titleStart,
														   0.0,
														   titleEnd - titleStart,
														   height)]];
	}
	if (titleStart - leftControlEnd >= minDragWidth) {
		[rects addObject:[NSValue valueWithRect:NSMakeRect(leftControlEnd,
														   0.0,
														   titleStart - leftControlEnd,
														   height)]];
	}
	if (rightControlStart - titleEnd >= minDragWidth) {
		[rects addObject:[NSValue valueWithRect:NSMakeRect(titleEnd,
														   0.0,
														   rightControlStart - titleEnd,
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

static ElectrobunNativeDragView *findNativeDragView(NSView *contentView,
													NSString *identifier) {
	if (contentView == nil || identifier == nil) {
		return nil;
	}
	for (NSView *subview in [contentView subviews]) {
		if ([subview isKindOfClass:[ElectrobunNativeDragView class]] &&
			[[subview identifier] isEqualToString:identifier]) {
			return (ElectrobunNativeDragView *)subview;
		}
	}

	return nil;
}

static ElectrobunNativeDragView *ensureNativeDragView(NSView *contentView,
													  NSString *identifier) {
	ElectrobunNativeDragView *view = findNativeDragView(contentView, identifier);
	if (view == nil) {
		view = [[ElectrobunNativeDragView alloc] initWithFrame:NSZeroRect];
		[view setIdentifier:identifier];
	}
	return view;
}

static void removeNativeDragView(NSView *contentView, NSString *identifier) {
	ElectrobunNativeDragView *view = findNativeDragView(contentView, identifier);
	if (view != nil) {
		[view removeFromSuperview];
	}
}

static ElectrobunNativeDragView *findNativeDragRightEdgeView(NSView *contentView) {
	return findNativeDragView(contentView,
							  kElectrobunNativeDragRightEdgeIdentifier);
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

extern "C" void freeNativeCString(char *value) {
	if (value != nullptr) {
		free(value);
	}
}

extern "C" char *createSecurityScopedBookmark(const char *path) {
	@autoreleasepool {
		if (path == nullptr || path[0] == '\0') {
			return nullptr;
		}
		NSString *pathString = [NSString stringWithUTF8String:path];
		if (pathString == nil) {
			return nullptr;
		}
		NSURL *url = [NSURL fileURLWithPath:pathString isDirectory:YES];
		if (url == nil) {
			return nullptr;
		}
		NSError *error = nil;
		NSData *bookmark = [url
			bookmarkDataWithOptions:NSURLBookmarkCreationWithSecurityScope
			includingResourceValuesForKeys:nil
			relativeToURL:nil
			error:&error];
		if (bookmark == nil || error != nil) {
			return nullptr;
		}
		return elizaCopyCString([bookmark base64EncodedStringWithOptions:0]);
	}
}

extern "C" char *startAccessingSecurityScopedBookmark(const char *base64) {
	@autoreleasepool {
		if (base64 == nullptr || base64[0] == '\0') {
			return nullptr;
		}
		NSString *base64String = [NSString stringWithUTF8String:base64];
		if (base64String == nil) {
			return nullptr;
		}
		NSData *bookmark = [[NSData alloc]
			initWithBase64EncodedString:base64String
			options:NSDataBase64DecodingIgnoreUnknownCharacters];
		if (bookmark == nil) {
			return nullptr;
		}
		BOOL stale = NO;
		NSError *error = nil;
		NSURL *url = [NSURL URLByResolvingBookmarkData:bookmark
			options:NSURLBookmarkResolutionWithSecurityScope
			relativeToURL:nil
			bookmarkDataIsStale:&stale
			error:&error];
		if (url == nil || error != nil) {
			return nullptr;
		}
		if (![url startAccessingSecurityScopedResource]) {
			return nullptr;
		}
		[elizaSecurityScopedUrls() addObject:url];
		return elizaCopyCString([url path]);
	}
}

extern "C" void stopAccessingSecurityScopedBookmarks(void) {
	@autoreleasepool {
		NSMutableArray<NSURL *> *urls = elizaSecurityScopedUrls();
		for (NSURL *url in urls) {
			[url stopAccessingSecurityScopedResource];
		}
		[urls removeAllObjects];
	}
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
		NSView *contentView = [window contentView];

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

		if (contentView != nil) {
			ElizaInactiveTrafficLightsOverlayView *oldOverlay =
				findInactiveTrafficLightsOverlay(buttonContainer);
			if (oldOverlay != nil) {
				[oldOverlay removeFromSuperview];
			}

			NSMutableArray<NSValue *> *buttonRectsInContent =
				[NSMutableArray arrayWithCapacity:3];
			NSRect overlayFrame = NSZeroRect;
			BOOL hasOverlayFrame = NO;
			for (NSButton *button in buttons) {
				NSRect contentRect =
					[buttonContainer convertRect:button.frame toView:contentView];
				[buttonRectsInContent addObject:[NSValue valueWithRect:contentRect]];
				overlayFrame =
					hasOverlayFrame ? NSUnionRect(overlayFrame, contentRect)
									: contentRect;
				hasOverlayFrame = YES;
			}

			if (hasOverlayFrame) {
				overlayFrame = NSInsetRect(overlayFrame, -1.0, -1.0);
				ElizaInactiveTrafficLightsOverlayView *overlay =
					ensureInactiveTrafficLightsOverlay(contentView);
				[overlay setFrame:overlayFrame];
				NSMutableArray<NSValue *> *dotRects =
					[NSMutableArray arrayWithCapacity:3];
				for (NSValue *value in buttonRectsInContent) {
					NSRect localRect = NSOffsetRect([value rectValue],
												   -overlayFrame.origin.x,
												   -overlayFrame.origin.y);
					[dotRects addObject:[NSValue valueWithRect:localRect]];
				}
				[overlay setDotRects:dotRects];
				[overlay setHidden:!inactive];
				[overlay setNeedsDisplay:YES];
				[contentView addSubview:overlay
							 positioned:NSWindowAbove
							 relativeTo:nil];
			}
		}

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
		CGFloat contentWidth = contentView.bounds.size.width;
		if (contentWidth <= 0.0) {
			return;
		}

		BOOL flipped = [contentView isFlipped];
		CGFloat dragY = flipped ? 0.0 : contentView.bounds.size.height - dragHeight;
		dragY = MAX(0.0, dragY);

		NSArray<NSValue *> *dragRects =
			elizaTitlebarNativeDragRects(contentWidth, dragHeight, flipped);
		NSArray<NSString *> *identifiers = elizaNativeDragViewIdentifiers();
		ElectrobunNativeDragView *lastDragView = nil;
		for (NSUInteger index = 0; index < [identifiers count]; index++) {
			NSString *identifier = identifiers[index];
			if (index >= [dragRects count]) {
				removeNativeDragView(contentView, identifier);
				continue;
			}

			NSRect localRect = [dragRects[index] rectValue];
			NSRect frame = NSMakeRect(MAX(dragX, localRect.origin.x),
									  dragY,
									  MAX(0.0,
										  NSMaxX(localRect) -
											  MAX(dragX, localRect.origin.x)),
									  localRect.size.height);
			if (frame.size.width <= 0.0 || frame.size.height <= 0.0) {
				removeNativeDragView(contentView, identifier);
				continue;
			}

			ElectrobunNativeDragView *dragView =
				ensureNativeDragView(contentView, identifier);
			[dragView setFrame:frame];
			[dragView setAutoresizingMask:NSViewNotSizable];

			// Electrobun may insert WKWebView after our first pass -> always
			// re-stack safe drag zones above the page. These zones deliberately do
			// not overlap titlebar buttons, so button clicks stay in WebKit.
			[contentView addSubview:dragView
						 positioned:NSWindowAbove
						 relativeTo:nil];
			lastDragView = dragView;
		}

		// Legacy Electrobun right-edge drag view would steal drags from the resize
		// band; remove so ElizaResizeStripView owns the east edge.
		ElectrobunNativeDragView *legacyRight =
			findNativeDragRightEdgeView(contentView);
		if (legacyRight != nil) {
			[legacyRight removeFromSuperview];
		}

		elizaInstallResizeStripOverlays(window, contentView, resizeDepth,
										lastDragView);

		success = YES;
	});

	return success;
}

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AVFoundation/AVFoundation.h>
#import <Availability.h>
#import <Contacts/Contacts.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreLocation/CoreLocation.h>
#import <EventKit/EventKit.h>
#import <UserNotifications/UserNotifications.h>
#include <math.h>
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

static NSString *elizaNSStringFromCString(const char *value) {
	if (value == nullptr) {
		return @"";
	}
	NSString *string = [NSString stringWithUTF8String:value];
	return string == nil ? @"" : string;
}

static NSDictionary *elizaJsonError(NSString *code, NSString *message) {
	return @{
		@"ok" : @NO,
		@"error" : code == nil ? @"native_error" : code,
		@"message" : message == nil ? @"" : message,
	};
}

static NSDictionary *elizaJsonOk(NSDictionary *fields) {
	NSMutableDictionary *out = [NSMutableDictionary dictionaryWithObject:@YES
																 forKey:@"ok"];
	if (fields != nil) {
		[out addEntriesFromDictionary:fields];
	}
	return out;
}

static char *elizaCopyJson(NSDictionary *object) {
	if (object == nil) {
		return elizaCopyCString(@"{\"ok\":false,\"error\":\"native_error\"}");
	}
	NSError *error = nil;
	NSData *data = [NSJSONSerialization dataWithJSONObject:object
												   options:0
													 error:&error];
	if (data == nil || error != nil) {
		return elizaCopyCString(@"{\"ok\":false,\"error\":\"native_error\",\"message\":\"Failed to encode native JSON.\"}");
	}
	NSString *json = [[NSString alloc] initWithData:data
										   encoding:NSUTF8StringEncoding];
	return elizaCopyCString(json);
}

static NSDictionary *elizaParseJsonObject(const char *json) {
	NSString *string = elizaNSStringFromCString(json);
	NSData *data = [string dataUsingEncoding:NSUTF8StringEncoding];
	if (data == nil) {
		return nil;
	}
	id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
	if (![object isKindOfClass:[NSDictionary class]]) {
		return nil;
	}
	return (NSDictionary *)object;
}

static NSString *elizaErrorMessage(NSError *error, NSString *fallback) {
	if (error != nil && [[error localizedDescription] length] > 0) {
		return [error localizedDescription];
	}
	return fallback == nil ? @"Native operation failed." : fallback;
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

API_AVAILABLE(macos(10.14))
static int elizaNotificationAuthorizationStatusToInt(
	UNAuthorizationStatus status) {
	switch (status) {
		case UNAuthorizationStatusAuthorized:
		case UNAuthorizationStatusProvisional:
			return 2;
		case UNAuthorizationStatusDenied:
			return 1;
		case UNAuthorizationStatusNotDetermined:
			return 0;
	}
	return 3;
}

/**
 * Check notification authorization without prompting.
 * Returns: 0=not-determined, 1=denied, 2=granted, 3=restricted
 */
extern "C" int checkNotificationPermission(void) {
	if (@available(macOS 10.14, *)) {
		__block int result = 0;
		dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
		[[UNUserNotificationCenter currentNotificationCenter]
			getNotificationSettingsWithCompletionHandler:
				^(UNNotificationSettings *settings) {
					result = elizaNotificationAuthorizationStatusToInt(
						[settings authorizationStatus]);
					dispatch_semaphore_signal(semaphore);
				}];
		dispatch_semaphore_wait(
			semaphore,
			dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)));
		return result;
	}
	return 2;
}

/**
 * Request notification authorization, then return the resulting status.
 */
extern "C" int requestNotificationPermission(void) {
	if (@available(macOS 10.14, *)) {
		__block int result = 0;
		dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
		UNAuthorizationOptions options =
			UNAuthorizationOptionAlert | UNAuthorizationOptionSound |
			UNAuthorizationOptionBadge;
		[[UNUserNotificationCenter currentNotificationCenter]
			requestAuthorizationWithOptions:options
						  completionHandler:^(BOOL granted, NSError *error) {
			if (error != nil) {
				result = 1;
				dispatch_semaphore_signal(semaphore);
				return;
			}
			if (!granted) {
				result = 1;
				dispatch_semaphore_signal(semaphore);
				return;
			}
			[[UNUserNotificationCenter currentNotificationCenter]
				getNotificationSettingsWithCompletionHandler:
					^(UNNotificationSettings *settings) {
						result = elizaNotificationAuthorizationStatusToInt(
							[settings authorizationStatus]);
						dispatch_semaphore_signal(semaphore);
					}];
		}];
		dispatch_semaphore_wait(
			semaphore,
			dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)));
		return result;
	}
	return 2;
}

static int elizaEventKitAuthorizationStatusToInt(EKAuthorizationStatus status) {
	NSInteger raw = (NSInteger)status;
	if (raw == 0) return 0; // not determined
	if (raw == 2) return 1; // denied
	if (raw == 3) return 2; // full access / legacy authorized
	if (raw == 1) return 3; // restricted
	if (raw == 4) return 4; // write-only events: not enough for read/update
	return 3;
}

static BOOL elizaEventKitHasFullAccess(EKEntityType entityType) {
	EKAuthorizationStatus status =
		[EKEventStore authorizationStatusForEntityType:entityType];
	return (NSInteger)status == 3;
}

static int elizaContactsAuthorizationStatusToInt(CNAuthorizationStatus status) {
	NSInteger raw = (NSInteger)status;
	if (raw == 0) return 0; // not determined
	if (raw == 2) return 1; // denied
	if (raw == 3 || raw == 4) return 2; // authorized or limited
	if (raw == 1) return 3; // restricted
	return 3;
}

static BOOL elizaContactsHasAccess(void) {
	CNAuthorizationStatus status =
		[CNContactStore authorizationStatusForEntityType:CNEntityTypeContacts];
	NSInteger raw = (NSInteger)status;
	return raw == 3 || raw == 4;
}

static int elizaLocationAuthorizationStatusToInt(CLAuthorizationStatus status) {
	switch (status) {
	case kCLAuthorizationStatusNotDetermined:
		return 0;
	case kCLAuthorizationStatusDenied:
		return 1;
	case kCLAuthorizationStatusAuthorizedAlways:
		return 2;
	case kCLAuthorizationStatusRestricted:
	default:
		return 3;
	}
}

static CLAuthorizationStatus elizaLocationAuthorizationStatus(
	CLLocationManager *manager) {
	if (@available(macOS 11.0, *)) {
		return [manager authorizationStatus];
	}
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
	return [CLLocationManager authorizationStatus];
#pragma clang diagnostic pop
}

@interface ElizaLocationAuthorizationDelegate
	: NSObject <CLLocationManagerDelegate>
@property(nonatomic) dispatch_semaphore_t semaphore;
@property(nonatomic) BOOL completed;
@end

@implementation ElizaLocationAuthorizationDelegate
- (void)finish {
	if (self.completed) {
		return;
	}
	self.completed = YES;
	dispatch_semaphore_signal(self.semaphore);
}

- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
	(void)manager;
	[self finish];
}

- (void)locationManager:(CLLocationManager *)manager
	didChangeAuthorizationStatus:(CLAuthorizationStatus)status {
	(void)manager;
	(void)status;
	[self finish];
}

- (void)locationManager:(CLLocationManager *)manager
	   didFailWithError:(NSError *)error {
	(void)manager;
	(void)error;
	[self finish];
}
@end

extern "C" int checkLocationPermission(void) {
	if (![CLLocationManager locationServicesEnabled]) {
		return 3;
	}
	CLLocationManager *manager = [[CLLocationManager alloc] init];
	CLAuthorizationStatus status = elizaLocationAuthorizationStatus(manager);
	return elizaLocationAuthorizationStatusToInt(status);
}

extern "C" int requestLocationPermission(void) {
	@autoreleasepool {
		if (![CLLocationManager locationServicesEnabled]) {
			return 3;
		}
		CLLocationManager *manager = [[CLLocationManager alloc] init];
		CLAuthorizationStatus status = elizaLocationAuthorizationStatus(manager);
		if (status != kCLAuthorizationStatusNotDetermined) {
			return elizaLocationAuthorizationStatusToInt(status);
		}

		ElizaLocationAuthorizationDelegate *delegate =
			[[ElizaLocationAuthorizationDelegate alloc] init];
		delegate.semaphore = dispatch_semaphore_create(0);
		manager.delegate = delegate;
		[manager requestWhenInUseAuthorization];
		dispatch_semaphore_wait(
			delegate.semaphore,
			dispatch_time(DISPATCH_TIME_NOW, (int64_t)(120 * NSEC_PER_SEC)));
		manager.delegate = nil;
		return checkLocationPermission();
	}
}

extern "C" int checkRemindersPermission(void) {
	return elizaEventKitAuthorizationStatusToInt(
		[EKEventStore authorizationStatusForEntityType:EKEntityTypeReminder]);
}

extern "C" int requestRemindersPermission(void) {
	@autoreleasepool {
		EKEventStore *store = [[EKEventStore alloc] init];
		dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
		if (@available(macOS 14.0, *)) {
			[store requestFullAccessToRemindersWithCompletion:
					   ^(BOOL granted, NSError *error) {
				(void)granted;
				(void)error;
				dispatch_semaphore_signal(semaphore);
			}];
		} else {
			#pragma clang diagnostic push
			#pragma clang diagnostic ignored "-Wdeprecated-declarations"
			[store requestAccessToEntityType:EKEntityTypeReminder
								  completion:^(BOOL granted, NSError *error) {
				(void)granted;
				(void)error;
				dispatch_semaphore_signal(semaphore);
			}];
			#pragma clang diagnostic pop
		}
		dispatch_semaphore_wait(
			semaphore,
			dispatch_time(DISPATCH_TIME_NOW, (int64_t)(120 * NSEC_PER_SEC)));
		return checkRemindersPermission();
	}
}

extern "C" int checkCalendarPermission(void) {
	return elizaEventKitAuthorizationStatusToInt(
		[EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent]);
}

extern "C" int requestCalendarPermission(void) {
	@autoreleasepool {
		EKEventStore *store = [[EKEventStore alloc] init];
		dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
		if (@available(macOS 14.0, *)) {
			[store requestFullAccessToEventsWithCompletion:
					   ^(BOOL granted, NSError *error) {
				(void)granted;
				(void)error;
				dispatch_semaphore_signal(semaphore);
			}];
		} else {
			#pragma clang diagnostic push
			#pragma clang diagnostic ignored "-Wdeprecated-declarations"
			[store requestAccessToEntityType:EKEntityTypeEvent
								  completion:^(BOOL granted, NSError *error) {
				(void)granted;
				(void)error;
				dispatch_semaphore_signal(semaphore);
			}];
			#pragma clang diagnostic pop
		}
		dispatch_semaphore_wait(
			semaphore,
			dispatch_time(DISPATCH_TIME_NOW, (int64_t)(120 * NSEC_PER_SEC)));
		return checkCalendarPermission();
	}
}

extern "C" int checkContactsPermission(void) {
	return elizaContactsAuthorizationStatusToInt(
		[CNContactStore authorizationStatusForEntityType:CNEntityTypeContacts]);
}

extern "C" int requestContactsPermission(void) {
	@autoreleasepool {
		CNContactStore *store = [[CNContactStore alloc] init];
		dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
		[store requestAccessForEntityType:CNEntityTypeContacts
						completionHandler:^(BOOL granted, NSError *error) {
			(void)granted;
			(void)error;
			dispatch_semaphore_signal(semaphore);
		}];
		dispatch_semaphore_wait(
			semaphore,
			dispatch_time(DISPATCH_TIME_NOW, (int64_t)(120 * NSEC_PER_SEC)));
		return checkContactsPermission();
	}
}

static void elizaApplyReminderDueDate(EKReminder *reminder,
									  double dueAtSeconds) {
	if (dueAtSeconds <= 0) {
		[reminder setDueDateComponents:nil];
		[reminder setAlarms:@[]];
		return;
	}
	NSDate *dueDate = [NSDate dateWithTimeIntervalSince1970:dueAtSeconds];
	NSCalendar *calendar = [NSCalendar currentCalendar];
	NSDateComponents *components =
		[calendar components:(NSCalendarUnitYear | NSCalendarUnitMonth |
							  NSCalendarUnitDay | NSCalendarUnitHour |
							  NSCalendarUnitMinute | NSCalendarUnitSecond)
					fromDate:dueDate];
	[components setTimeZone:[NSTimeZone localTimeZone]];
	[reminder setDueDateComponents:components];
	[reminder setAlarms:@[[EKAlarm alarmWithAbsoluteDate:dueDate]]];
}

static EKCalendar *elizaDefaultReminderCalendar(EKEventStore *store) {
	EKCalendar *calendar = [store defaultCalendarForNewReminders];
	if (calendar != nil) {
		return calendar;
	}
	NSArray<EKCalendar *> *calendars =
		[store calendarsForEntityType:EKEntityTypeReminder];
	return [calendars count] > 0 ? [calendars objectAtIndex:0] : nil;
}

extern "C" char *createAppleReminderJson(const char *title,
										 const char *notes,
										 double dueAtSeconds,
										 int priority) {
	@autoreleasepool {
		if (!elizaEventKitHasFullAccess(EKEntityTypeReminder)) {
			return elizaCopyJson(elizaJsonError(
				@"permission",
				@"Apple Reminders access has not been granted."));
		}
		NSString *titleString = [elizaNSStringFromCString(title)
			stringByTrimmingCharactersInSet:[NSCharacterSet
											 whitespaceAndNewlineCharacterSet]];
		if ([titleString length] == 0) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"Reminder title is required."));
		}
		EKEventStore *store = [[EKEventStore alloc] init];
		EKCalendar *calendar = elizaDefaultReminderCalendar(store);
		if (calendar == nil) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"No writable Apple Reminders list is available."));
		}
		EKReminder *reminder = [EKReminder reminderWithEventStore:store];
		[reminder setTitle:titleString];
		NSString *notesString = elizaNSStringFromCString(notes);
		[reminder setNotes:[notesString length] > 0 ? notesString : nil];
		[reminder setCalendar:calendar];
		[reminder setPriority:priority];
		elizaApplyReminderDueDate(reminder, dueAtSeconds);

		NSError *error = nil;
		BOOL ok = [store saveReminder:reminder commit:YES error:&error];
		if (!ok) {
			return elizaCopyJson(elizaJsonError(
				@"native_error",
				elizaErrorMessage(error, @"Failed to create Apple reminder.")));
		}
		NSString *reminderId = [reminder calendarItemIdentifier] ?: @"";
		return elizaCopyJson(elizaJsonOk(@{@"reminderId" : reminderId}));
	}
}

extern "C" char *updateAppleReminderJson(const char *reminderId,
										 const char *title,
										 const char *notes,
										 double dueAtSeconds,
										 int priority) {
	@autoreleasepool {
		if (!elizaEventKitHasFullAccess(EKEntityTypeReminder)) {
			return elizaCopyJson(elizaJsonError(
				@"permission",
				@"Apple Reminders access has not been granted."));
		}
		NSString *identifier = [elizaNSStringFromCString(reminderId)
			stringByTrimmingCharactersInSet:[NSCharacterSet
											 whitespaceAndNewlineCharacterSet]];
		NSString *titleString = [elizaNSStringFromCString(title)
			stringByTrimmingCharactersInSet:[NSCharacterSet
											 whitespaceAndNewlineCharacterSet]];
		if ([identifier length] == 0 || [titleString length] == 0) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"Reminder id and title are required."));
		}
		EKEventStore *store = [[EKEventStore alloc] init];
		EKCalendarItem *item = [store calendarItemWithIdentifier:identifier];
		if (item == nil || ![item isKindOfClass:[EKReminder class]]) {
			return elizaCopyJson(elizaJsonError(
				@"not_found", @"Apple reminder was not found."));
		}
		EKReminder *reminder = (EKReminder *)item;
		[reminder setTitle:titleString];
		NSString *notesString = elizaNSStringFromCString(notes);
		[reminder setNotes:[notesString length] > 0 ? notesString : nil];
		[reminder setPriority:priority];
		elizaApplyReminderDueDate(reminder, dueAtSeconds);

		NSError *error = nil;
		BOOL ok = [store saveReminder:reminder commit:YES error:&error];
		if (!ok) {
			return elizaCopyJson(elizaJsonError(
				@"native_error",
				elizaErrorMessage(error, @"Failed to update Apple reminder.")));
		}
		NSString *nextId = [reminder calendarItemIdentifier] ?: identifier;
		return elizaCopyJson(elizaJsonOk(@{@"reminderId" : nextId}));
	}
}

extern "C" char *deleteAppleReminderJson(const char *reminderId) {
	@autoreleasepool {
		if (!elizaEventKitHasFullAccess(EKEntityTypeReminder)) {
			return elizaCopyJson(elizaJsonError(
				@"permission",
				@"Apple Reminders access has not been granted."));
		}
		NSString *identifier = [elizaNSStringFromCString(reminderId)
			stringByTrimmingCharactersInSet:[NSCharacterSet
											 whitespaceAndNewlineCharacterSet]];
		if ([identifier length] == 0) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"Reminder id is required."));
		}
		EKEventStore *store = [[EKEventStore alloc] init];
		EKCalendarItem *item = [store calendarItemWithIdentifier:identifier];
		if (item == nil || ![item isKindOfClass:[EKReminder class]]) {
			return elizaCopyJson(elizaJsonError(
				@"not_found", @"Apple reminder was not found."));
		}
		NSError *error = nil;
		BOOL ok = [store removeReminder:(EKReminder *)item commit:YES error:&error];
		if (!ok) {
			return elizaCopyJson(elizaJsonError(
				@"native_error",
				elizaErrorMessage(error, @"Failed to delete Apple reminder.")));
		}
		return elizaCopyJson(elizaJsonOk(nil));
	}
}

static NSString *elizaPayloadString(NSDictionary *payload, NSString *key);
static NSArray *elizaPayloadArray(NSDictionary *payload, NSString *key);

static NSISO8601DateFormatter *elizaISO8601FormatterWithFractionalSeconds(void) {
	static NSISO8601DateFormatter *formatter = nil;
	static dispatch_once_t onceToken;
	dispatch_once(&onceToken, ^{
		formatter = [[NSISO8601DateFormatter alloc] init];
		formatter.formatOptions =
			NSISO8601DateFormatWithInternetDateTime |
			NSISO8601DateFormatWithFractionalSeconds;
	});
	return formatter;
}

static NSISO8601DateFormatter *elizaISO8601FormatterWithoutFractionalSeconds(void) {
	static NSISO8601DateFormatter *formatter = nil;
	static dispatch_once_t onceToken;
	dispatch_once(&onceToken, ^{
		formatter = [[NSISO8601DateFormatter alloc] init];
		formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
	});
	return formatter;
}

static NSDate *elizaDateFromISO8601String(NSString *value) {
	if ([value length] == 0) {
		return nil;
	}
	NSDate *date =
		[elizaISO8601FormatterWithFractionalSeconds() dateFromString:value];
	if (date != nil) {
		return date;
	}
	return [elizaISO8601FormatterWithoutFractionalSeconds() dateFromString:value];
}

static NSString *elizaISO8601StringFromDate(NSDate *date) {
	if (date == nil) {
		return @"";
	}
	return [elizaISO8601FormatterWithFractionalSeconds() stringFromDate:date];
}

static NSString *elizaEventStatusString(EKEventStatus status) {
	switch (status) {
		case EKEventStatusNone:
			return @"none";
		case EKEventStatusConfirmed:
			return @"confirmed";
		case EKEventStatusTentative:
			return @"tentative";
		case EKEventStatusCanceled:
			return @"cancelled";
	}
	return @"unknown";
}

static NSString *elizaParticipantStatusString(EKParticipantStatus status) {
	switch (status) {
		case EKParticipantStatusUnknown:
			return @"unknown";
		case EKParticipantStatusPending:
			return @"pending";
		case EKParticipantStatusAccepted:
			return @"accepted";
		case EKParticipantStatusDeclined:
			return @"declined";
		case EKParticipantStatusTentative:
			return @"tentative";
		case EKParticipantStatusDelegated:
			return @"delegated";
		case EKParticipantStatusCompleted:
			return @"completed";
		case EKParticipantStatusInProcess:
			return @"in_process";
	}
	return @"unknown";
}

static NSString *elizaParticipantEmail(EKParticipant *participant) {
	NSURL *url = [participant URL];
	if (url == nil) {
		return @"";
	}
	if ([[[url scheme] lowercaseString] isEqualToString:@"mailto"]) {
		return [[url resourceSpecifier] stringByRemovingPercentEncoding] ?: @"";
	}
	return @"";
}

static NSDictionary *elizaParticipantJson(EKParticipant *participant) {
	NSString *email = elizaParticipantEmail(participant);
	return @{
		@"email" : [email length] > 0 ? email : (id)[NSNull null],
		@"displayName" : [[participant name] length] > 0
			? [participant name]
			: (id)[NSNull null],
		@"responseStatus" : elizaParticipantStatusString(
			[participant participantStatus]),
		@"self" : @([participant isCurrentUser]),
		@"organizer" : @([participant participantRole] == EKParticipantRoleChair),
		@"optional" :
			@([participant participantRole] == EKParticipantRoleOptional),
	};
}

static NSString *elizaHexColorFromCGColor(CGColorRef colorRef) {
	if (colorRef == nil) {
		return nil;
	}
	NSColor *color = [NSColor colorWithCGColor:colorRef];
	NSColor *rgb =
		[color colorUsingColorSpace:[NSColorSpace sRGBColorSpace]];
	if (rgb == nil) {
		return nil;
	}
	int r = (int)lrint(MAX(0, MIN(1, [rgb redComponent])) * 255.0);
	int g = (int)lrint(MAX(0, MIN(1, [rgb greenComponent])) * 255.0);
	int b = (int)lrint(MAX(0, MIN(1, [rgb blueComponent])) * 255.0);
	return [NSString stringWithFormat:@"#%02X%02X%02X", r, g, b];
}

static EKCalendar *elizaDefaultEventCalendar(EKEventStore *store) {
	EKCalendar *calendar = [store defaultCalendarForNewEvents];
	if (calendar != nil && [calendar allowsContentModifications]) {
		return calendar;
	}
	for (EKCalendar *candidate in [store calendarsForEntityType:EKEntityTypeEvent]) {
		if ([candidate allowsContentModifications]) {
			return candidate;
		}
	}
	return nil;
}

static EKCalendar *elizaEventCalendarForIdentifier(EKEventStore *store,
												   NSString *identifier,
												   BOOL requireWritable) {
	if ([identifier length] == 0 || [identifier isEqualToString:@"primary"]) {
		return requireWritable ? elizaDefaultEventCalendar(store)
							   : [store defaultCalendarForNewEvents];
	}
	for (EKCalendar *calendar in [store calendarsForEntityType:EKEntityTypeEvent]) {
		if ([[calendar calendarIdentifier] isEqualToString:identifier]) {
			if (requireWritable && ![calendar allowsContentModifications]) {
				return nil;
			}
			return calendar;
		}
	}
	return nil;
}

static NSDictionary *elizaCalendarJson(EKCalendar *calendar,
									   EKCalendar *defaultCalendar) {
	NSString *color = elizaHexColorFromCGColor([calendar CGColor]);
	NSString *calendarId = [calendar calendarIdentifier] ?: @"";
	NSString *defaultId = [defaultCalendar calendarIdentifier] ?: @"";
	EKSource *source = [calendar source];
	return @{
		@"calendarId" : calendarId,
		@"summary" : [calendar title] ?: @"Calendar",
		@"description" : [[source title] length] > 0 ? [source title]
													  : (id)[NSNull null],
		@"primary" : @([calendarId length] > 0 &&
					   [calendarId isEqualToString:defaultId]),
		@"accessRole" : [calendar allowsContentModifications] ? @"writer"
															  : @"reader",
		@"backgroundColor" : color ?: (id)[NSNull null],
		@"foregroundColor" : [NSNull null],
		@"timeZone" : [[[NSTimeZone localTimeZone] name] length] > 0
			? [[NSTimeZone localTimeZone] name]
			: (id)[NSNull null],
		@"selected" : @YES,
	};
}

static NSDictionary *elizaEventJson(EKEvent *event) {
	EKCalendar *calendar = [event calendar];
	NSString *identifier =
		[event calendarItemIdentifier] ?: [event eventIdentifier] ?: @"";
	NSMutableArray *attendees = [NSMutableArray array];
	NSArray<EKParticipant *> *eventAttendees = [event attendees] ?: @[];
	for (EKParticipant *attendee in eventAttendees) {
		[attendees addObject:elizaParticipantJson(attendee)];
	}
	id organizer = [event organizer] != nil
		? (id)elizaParticipantJson([event organizer])
		: (id)[NSNull null];
	return @{
		@"id" : identifier,
		@"externalId" : identifier,
		@"calendarId" : [calendar calendarIdentifier] ?: @"",
		@"calendarSummary" : [calendar title] ?: @"",
		@"title" : [[event title] length] > 0 ? [event title] : @"(untitled)",
		@"description" : [event notes] ?: @"",
		@"location" : [event location] ?: @"",
		@"status" : elizaEventStatusString([event status]),
		@"startAt" : elizaISO8601StringFromDate([event startDate]),
		@"endAt" : elizaISO8601StringFromDate([event endDate]),
		@"isAllDay" : @([event isAllDay]),
		@"timezone" : [[event timeZone] name] ?: (id)[NSNull null],
		@"htmlLink" : [NSNull null],
		@"conferenceLink" : [NSNull null],
		@"organizer" : organizer,
		@"attendees" : attendees,
	};
}

static NSDictionary *elizaAppleCalendarUnsupportedAttendeesError(void) {
	return elizaJsonError(
		@"unsupported_feature",
		@"Apple Calendar does not allow this app to create or edit event invitees through EventKit. Remove attendees or use Google Calendar for invited meetings.");
}

static NSDictionary *elizaApplyEventPayload(EKEvent *event,
											NSDictionary *payload,
											EKEventStore *store,
											BOOL requireTitle,
											NSError **errorOut) {
	(void)errorOut;
	NSArray *attendees = elizaPayloadArray(payload, @"attendees");
	if ([attendees count] > 0) {
		return elizaAppleCalendarUnsupportedAttendeesError();
	}
	if ([payload objectForKey:@"title"] != nil || requireTitle) {
		NSString *title = [elizaPayloadString(payload, @"title")
			stringByTrimmingCharactersInSet:[NSCharacterSet
											 whitespaceAndNewlineCharacterSet]];
		if ([title length] == 0) {
			return elizaJsonError(@"native_error", @"Calendar event title is required.");
		}
		[event setTitle:title];
	}
	if ([payload objectForKey:@"description"] != nil ||
		[payload objectForKey:@"notes"] != nil) {
		NSString *notes = elizaPayloadString(
			payload,
			[payload objectForKey:@"description"] != nil ? @"description" : @"notes");
		[event setNotes:[notes length] > 0 ? notes : nil];
	}
	if ([payload objectForKey:@"location"] != nil) {
		NSString *location = elizaPayloadString(payload, @"location");
		[event setLocation:[location length] > 0 ? location : nil];
	}
	if ([payload objectForKey:@"timeZone"] != nil) {
		NSString *timeZoneName = elizaPayloadString(payload, @"timeZone");
		NSTimeZone *timeZone = [NSTimeZone timeZoneWithName:timeZoneName];
		if (timeZone != nil) {
			[event setTimeZone:timeZone];
		}
	}
	if ([payload objectForKey:@"calendarId"] != nil) {
		EKCalendar *calendar = elizaEventCalendarForIdentifier(
			store,
			elizaPayloadString(payload, @"calendarId"),
			YES);
		if (calendar == nil) {
			return elizaJsonError(
				@"native_error",
				@"The selected Apple Calendar is not writable or was not found.");
		}
		[event setCalendar:calendar];
	}
	if ([payload objectForKey:@"isAllDay"] != nil) {
		id raw = [payload objectForKey:@"isAllDay"];
		if ([raw isKindOfClass:[NSNumber class]]) {
			[event setAllDay:[(NSNumber *)raw boolValue]];
		}
	}
	if ([payload objectForKey:@"startAt"] != nil) {
		NSDate *start = elizaDateFromISO8601String(
			elizaPayloadString(payload, @"startAt"));
		if (start == nil) {
			return elizaJsonError(@"native_error", @"Calendar event startAt is invalid.");
		}
		[event setStartDate:start];
	}
	if ([payload objectForKey:@"endAt"] != nil) {
		NSDate *end =
			elizaDateFromISO8601String(elizaPayloadString(payload, @"endAt"));
		if (end == nil) {
			return elizaJsonError(@"native_error", @"Calendar event endAt is invalid.");
		}
		[event setEndDate:end];
	}
	if ([event startDate] == nil || [event endDate] == nil) {
		return elizaJsonError(
			@"native_error",
			@"Calendar event startAt and endAt are required.");
	}
	if ([[event endDate] timeIntervalSinceDate:[event startDate]] <= 0) {
		return elizaJsonError(
			@"native_error",
			@"Calendar event endAt must be later than startAt.");
	}
	if ([event calendar] == nil) {
		EKCalendar *calendar = elizaDefaultEventCalendar(store);
		if (calendar == nil) {
			return elizaJsonError(
				@"native_error",
				@"No writable Apple Calendar is available.");
		}
		[event setCalendar:calendar];
	}
	return nil;
}

extern "C" char *listAppleCalendarsJson(void) {
	@autoreleasepool {
		if (!elizaEventKitHasFullAccess(EKEntityTypeEvent)) {
			return elizaCopyJson(elizaJsonError(
				@"permission", @"Apple Calendar access has not been granted."));
		}
		EKEventStore *store = [[EKEventStore alloc] init];
		EKCalendar *defaultCalendar = [store defaultCalendarForNewEvents];
		NSMutableArray *calendars = [NSMutableArray array];
		for (EKCalendar *calendar in [store calendarsForEntityType:EKEntityTypeEvent]) {
			[calendars addObject:elizaCalendarJson(calendar, defaultCalendar)];
		}
		return elizaCopyJson(elizaJsonOk(@{@"calendars" : calendars}));
	}
}

extern "C" char *listAppleCalendarEventsJson(const char *calendarId,
											 double startSeconds,
											 double endSeconds) {
	@autoreleasepool {
		if (!elizaEventKitHasFullAccess(EKEntityTypeEvent)) {
			return elizaCopyJson(elizaJsonError(
				@"permission", @"Apple Calendar access has not been granted."));
		}
		if (endSeconds <= startSeconds) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"Calendar event window is invalid."));
		}
		EKEventStore *store = [[EKEventStore alloc] init];
		NSString *identifier = [elizaNSStringFromCString(calendarId)
			stringByTrimmingCharactersInSet:[NSCharacterSet
											 whitespaceAndNewlineCharacterSet]];
		NSArray<EKCalendar *> *calendars = nil;
		if ([identifier length] > 0 && ![identifier isEqualToString:@"all"]) {
			EKCalendar *calendar =
				elizaEventCalendarForIdentifier(store, identifier, NO);
			if (calendar == nil) {
				return elizaCopyJson(elizaJsonError(
					@"not_found", @"Apple Calendar was not found."));
			}
			calendars = @[calendar];
		}
		NSDate *start = [NSDate dateWithTimeIntervalSince1970:startSeconds];
		NSDate *end = [NSDate dateWithTimeIntervalSince1970:endSeconds];
		NSPredicate *predicate = [store predicateForEventsWithStartDate:start
																endDate:end
															  calendars:calendars];
		NSArray<EKEvent *> *events =
			[[store eventsMatchingPredicate:predicate]
				sortedArrayUsingComparator:^NSComparisonResult(EKEvent *left,
															   EKEvent *right) {
			return [[left startDate] compare:[right startDate]];
		}];
		NSMutableArray *rows = [NSMutableArray array];
		for (EKEvent *event in events) {
			[rows addObject:elizaEventJson(event)];
		}
		return elizaCopyJson(elizaJsonOk(@{@"events" : rows}));
	}
}

extern "C" char *createAppleCalendarEventJson(const char *payloadJson) {
	@autoreleasepool {
		if (!elizaEventKitHasFullAccess(EKEntityTypeEvent)) {
			return elizaCopyJson(elizaJsonError(
				@"permission", @"Apple Calendar access has not been granted."));
		}
		NSDictionary *payload = elizaParseJsonObject(payloadJson);
		if (payload == nil) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"Invalid calendar event payload."));
		}
		EKEventStore *store = [[EKEventStore alloc] init];
		EKEvent *event = [EKEvent eventWithEventStore:store];
		NSDictionary *payloadError =
			elizaApplyEventPayload(event, payload, store, YES, nil);
		if (payloadError != nil) {
			return elizaCopyJson(payloadError);
		}
		NSError *error = nil;
		BOOL ok = [store saveEvent:event
							   span:EKSpanThisEvent
							 commit:YES
							  error:&error];
		if (!ok) {
			return elizaCopyJson(elizaJsonError(
				@"native_error",
				elizaErrorMessage(error, @"Failed to create Apple Calendar event.")));
		}
		return elizaCopyJson(elizaJsonOk(@{@"event" : elizaEventJson(event)}));
	}
}

extern "C" char *updateAppleCalendarEventJson(const char *eventId,
											 const char *payloadJson) {
	@autoreleasepool {
		if (!elizaEventKitHasFullAccess(EKEntityTypeEvent)) {
			return elizaCopyJson(elizaJsonError(
				@"permission", @"Apple Calendar access has not been granted."));
		}
		NSString *identifier = [elizaNSStringFromCString(eventId)
			stringByTrimmingCharactersInSet:[NSCharacterSet
											 whitespaceAndNewlineCharacterSet]];
		NSDictionary *payload = elizaParseJsonObject(payloadJson);
		if ([identifier length] == 0 || payload == nil) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"Calendar event id and payload are required."));
		}
		EKEventStore *store = [[EKEventStore alloc] init];
		EKCalendarItem *item = [store calendarItemWithIdentifier:identifier];
		if (item == nil || ![item isKindOfClass:[EKEvent class]]) {
			return elizaCopyJson(elizaJsonError(
				@"not_found", @"Apple Calendar event was not found."));
		}
		EKEvent *event = (EKEvent *)item;
		if (![[event calendar] allowsContentModifications]) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"Apple Calendar event is not writable."));
		}
		NSDictionary *payloadError =
			elizaApplyEventPayload(event, payload, store, NO, nil);
		if (payloadError != nil) {
			return elizaCopyJson(payloadError);
		}
		NSError *error = nil;
		BOOL ok = [store saveEvent:event
							   span:EKSpanThisEvent
							 commit:YES
							  error:&error];
		if (!ok) {
			return elizaCopyJson(elizaJsonError(
				@"native_error",
				elizaErrorMessage(error, @"Failed to update Apple Calendar event.")));
		}
		return elizaCopyJson(elizaJsonOk(@{@"event" : elizaEventJson(event)}));
	}
}

extern "C" char *deleteAppleCalendarEventJson(const char *eventId) {
	@autoreleasepool {
		if (!elizaEventKitHasFullAccess(EKEntityTypeEvent)) {
			return elizaCopyJson(elizaJsonError(
				@"permission", @"Apple Calendar access has not been granted."));
		}
		NSString *identifier = [elizaNSStringFromCString(eventId)
			stringByTrimmingCharactersInSet:[NSCharacterSet
											 whitespaceAndNewlineCharacterSet]];
		if ([identifier length] == 0) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"Calendar event id is required."));
		}
		EKEventStore *store = [[EKEventStore alloc] init];
		EKCalendarItem *item = [store calendarItemWithIdentifier:identifier];
		if (item == nil || ![item isKindOfClass:[EKEvent class]]) {
			return elizaCopyJson(elizaJsonError(
				@"not_found", @"Apple Calendar event was not found."));
		}
		EKEvent *event = (EKEvent *)item;
		NSError *error = nil;
		BOOL ok = [store removeEvent:event
								  span:EKSpanThisEvent
								commit:YES
								 error:&error];
		if (!ok) {
			return elizaCopyJson(elizaJsonError(
				@"native_error",
				elizaErrorMessage(error, @"Failed to delete Apple Calendar event.")));
		}
		return elizaCopyJson(elizaJsonOk(nil));
	}
}

static NSArray<id<CNKeyDescriptor>> *elizaContactKeys(void) {
	return @[
		CNContactIdentifierKey,
		CNContactGivenNameKey,
		CNContactFamilyNameKey,
		CNContactPhoneNumbersKey,
		CNContactEmailAddressesKey,
		[CNContactFormatter
			descriptorForRequiredKeysForStyle:CNContactFormatterStyleFullName],
	];
}

static NSString *elizaContactDisplayName(CNContact *contact) {
	NSString *name = [CNContactFormatter
		stringFromContact:contact
					style:CNContactFormatterStyleFullName];
	if ([name length] > 0) {
		return name;
	}
	NSString *joined =
		[[NSString stringWithFormat:@"%@ %@", [contact givenName], [contact familyName]]
			stringByTrimmingCharactersInSet:[NSCharacterSet
											 whitespaceAndNewlineCharacterSet]];
	return [joined length] > 0 ? joined : @"";
}

static NSDictionary *elizaPhoneEntry(CNLabeledValue<CNPhoneNumber *> *entry) {
	return @{
		@"label" : [entry label] ?: [NSNull null],
		@"value" : [[entry value] stringValue] ?: @"",
	};
}

static NSDictionary *elizaEmailEntry(CNLabeledValue<NSString *> *entry) {
	return @{
		@"label" : [entry label] ?: [NSNull null],
		@"value" : [entry value] ?: @"",
	};
}

static NSDictionary *elizaFullContactJson(CNContact *contact) {
	NSMutableArray *phones = [NSMutableArray array];
	for (CNLabeledValue<CNPhoneNumber *> *phone in [contact phoneNumbers]) {
		[phones addObject:elizaPhoneEntry(phone)];
	}
	NSMutableArray *emails = [NSMutableArray array];
	for (CNLabeledValue<NSString *> *email in [contact emailAddresses]) {
		[emails addObject:elizaEmailEntry(email)];
	}
	return @{
		@"id" : [contact identifier] ?: @"",
		@"name" : elizaContactDisplayName(contact),
		@"firstName" : [[contact givenName] length] > 0
			? [contact givenName]
			: (id)[NSNull null],
		@"lastName" : [[contact familyName] length] > 0
			? [contact familyName]
			: (id)[NSNull null],
		@"phones" : phones,
		@"emails" : emails,
	};
}

extern "C" char *loadContactsJson(void) {
	@autoreleasepool {
		if (!elizaContactsHasAccess()) {
			return elizaCopyJson(elizaJsonError(
				@"permission", @"Apple Contacts access has not been granted."));
		}
		CNContactStore *store = [[CNContactStore alloc] init];
		CNContactFetchRequest *request =
			[[CNContactFetchRequest alloc] initWithKeysToFetch:elizaContactKeys()];
		[request setUnifyResults:YES];
		NSMutableArray *rows = [NSMutableArray array];
		NSError *error = nil;
		BOOL ok = [store
			enumerateContactsWithFetchRequest:request
										error:&error
								   usingBlock:^(CNContact *contact, BOOL *stop) {
			(void)stop;
			NSString *name = elizaContactDisplayName(contact);
			for (CNLabeledValue<CNPhoneNumber *> *phone in [contact phoneNumbers]) {
				NSString *value = [[phone value] stringValue] ?: @"";
				if ([value length] > 0 && [name length] > 0) {
					[rows addObject:@{
						@"kind" : @"phone",
						@"handle" : value,
						@"name" : name,
					}];
				}
			}
			for (CNLabeledValue<NSString *> *email in [contact emailAddresses]) {
				NSString *value = [email value] ?: @"";
				if ([value length] > 0 && [name length] > 0) {
					[rows addObject:@{
						@"kind" : @"email",
						@"handle" : value,
						@"name" : name,
					}];
				}
			}
		}];
		if (!ok) {
			return elizaCopyJson(elizaJsonError(
				@"native_error",
				elizaErrorMessage(error, @"Failed to read Apple Contacts.")));
		}
		return elizaCopyJson(elizaJsonOk(@{@"contacts" : rows}));
	}
}

extern "C" char *listAllContactsJson(void) {
	@autoreleasepool {
		if (!elizaContactsHasAccess()) {
			return elizaCopyJson(elizaJsonError(
				@"permission", @"Apple Contacts access has not been granted."));
		}
		CNContactStore *store = [[CNContactStore alloc] init];
		CNContactFetchRequest *request =
			[[CNContactFetchRequest alloc] initWithKeysToFetch:elizaContactKeys()];
		[request setUnifyResults:YES];
		NSMutableArray *contacts = [NSMutableArray array];
		NSError *error = nil;
		BOOL ok = [store
			enumerateContactsWithFetchRequest:request
										error:&error
								   usingBlock:^(CNContact *contact, BOOL *stop) {
			(void)stop;
			[contacts addObject:elizaFullContactJson(contact)];
		}];
		if (!ok) {
			return elizaCopyJson(elizaJsonError(
				@"native_error",
				elizaErrorMessage(error, @"Failed to list Apple Contacts.")));
		}
		return elizaCopyJson(elizaJsonOk(@{@"contacts" : contacts}));
	}
}

static NSString *elizaPayloadString(NSDictionary *payload, NSString *key) {
	id value = [payload objectForKey:key];
	return [value isKindOfClass:[NSString class]] ? (NSString *)value : @"";
}

static NSArray *elizaPayloadArray(NSDictionary *payload, NSString *key) {
	id value = [payload objectForKey:key];
	return [value isKindOfClass:[NSArray class]] ? (NSArray *)value : @[];
}

static CNLabeledValue<CNPhoneNumber *> *elizaPayloadPhone(NSDictionary *entry) {
	NSString *value = elizaPayloadString(entry, @"value");
	if ([value length] == 0) {
		return nil;
	}
	NSString *label = elizaPayloadString(entry, @"label");
	if ([label length] == 0) {
		label = CNLabelPhoneNumberMobile;
	}
	return [CNLabeledValue labeledValueWithLabel:label
										   value:[CNPhoneNumber
													 phoneNumberWithStringValue:value]];
}

static CNLabeledValue<NSString *> *elizaPayloadEmail(NSDictionary *entry) {
	NSString *value = elizaPayloadString(entry, @"value");
	if ([value length] == 0) {
		return nil;
	}
	NSString *label = elizaPayloadString(entry, @"label");
	if ([label length] == 0) {
		label = CNLabelHome;
	}
	return [CNLabeledValue labeledValueWithLabel:label value:value];
}

static void elizaApplyContactPayload(CNMutableContact *contact,
									 NSDictionary *payload) {
	if ([payload objectForKey:@"firstName"] != nil) {
		[contact setGivenName:elizaPayloadString(payload, @"firstName")];
	}
	if ([payload objectForKey:@"lastName"] != nil) {
		[contact setFamilyName:elizaPayloadString(payload, @"lastName")];
	}
	NSMutableArray<CNLabeledValue<CNPhoneNumber *> *> *phones =
		[[contact phoneNumbers] mutableCopy];
	for (id value in elizaPayloadArray(payload, @"removePhones")) {
		if (![value isKindOfClass:[NSString class]]) {
			continue;
		}
		NSString *needle = (NSString *)value;
		NSIndexSet *matches = [phones
			indexesOfObjectsPassingTest:
				^BOOL(CNLabeledValue<CNPhoneNumber *> *entry,
					  NSUInteger idx,
					  BOOL *stop) {
			(void)idx;
			(void)stop;
			return [[[entry value] stringValue] isEqualToString:needle];
		}];
		[phones removeObjectsAtIndexes:matches];
	}
	for (id value in elizaPayloadArray(payload, @"addPhones")) {
		if (![value isKindOfClass:[NSDictionary class]]) {
			continue;
		}
		CNLabeledValue<CNPhoneNumber *> *phone =
			elizaPayloadPhone((NSDictionary *)value);
		if (phone != nil) {
			[phones addObject:phone];
		}
	}
	if ([payload objectForKey:@"phones"] != nil) {
		[phones removeAllObjects];
		for (id value in elizaPayloadArray(payload, @"phones")) {
			if (![value isKindOfClass:[NSDictionary class]]) {
				continue;
			}
			CNLabeledValue<CNPhoneNumber *> *phone =
				elizaPayloadPhone((NSDictionary *)value);
			if (phone != nil) {
				[phones addObject:phone];
			}
		}
	}
	[contact setPhoneNumbers:phones];

	NSMutableArray<CNLabeledValue<NSString *> *> *emails =
		[[contact emailAddresses] mutableCopy];
	for (id value in elizaPayloadArray(payload, @"removeEmails")) {
		if (![value isKindOfClass:[NSString class]]) {
			continue;
		}
		NSString *needle = (NSString *)value;
		NSIndexSet *matches = [emails
			indexesOfObjectsPassingTest:
				^BOOL(CNLabeledValue<NSString *> *entry,
					  NSUInteger idx,
					  BOOL *stop) {
			(void)idx;
			(void)stop;
			return [[entry value] isEqualToString:needle];
		}];
		[emails removeObjectsAtIndexes:matches];
	}
	for (id value in elizaPayloadArray(payload, @"addEmails")) {
		if (![value isKindOfClass:[NSDictionary class]]) {
			continue;
		}
		CNLabeledValue<NSString *> *email =
			elizaPayloadEmail((NSDictionary *)value);
		if (email != nil) {
			[emails addObject:email];
		}
	}
	if ([payload objectForKey:@"emails"] != nil) {
		[emails removeAllObjects];
		for (id value in elizaPayloadArray(payload, @"emails")) {
			if (![value isKindOfClass:[NSDictionary class]]) {
				continue;
			}
			CNLabeledValue<NSString *> *email =
				elizaPayloadEmail((NSDictionary *)value);
			if (email != nil) {
				[emails addObject:email];
			}
		}
	}
	[contact setEmailAddresses:emails];
}

extern "C" char *addContactJson(const char *payloadJson) {
	@autoreleasepool {
		if (!elizaContactsHasAccess()) {
			return elizaCopyJson(elizaJsonError(
				@"permission", @"Apple Contacts access has not been granted."));
		}
		NSDictionary *payload = elizaParseJsonObject(payloadJson);
		if (payload == nil) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"Invalid contact payload."));
		}
		CNMutableContact *contact = [[CNMutableContact alloc] init];
		elizaApplyContactPayload(contact, payload);
		CNSaveRequest *request = [[CNSaveRequest alloc] init];
		[request addContact:contact toContainerWithIdentifier:nil];
		CNContactStore *store = [[CNContactStore alloc] init];
		NSError *error = nil;
		if (![store executeSaveRequest:request error:&error]) {
			return elizaCopyJson(elizaJsonError(
				@"native_error",
				elizaErrorMessage(error, @"Failed to create Apple contact.")));
		}
		return elizaCopyJson(elizaJsonOk(@{@"id" : [contact identifier] ?: @""}));
	}
}

extern "C" char *updateContactJson(const char *personId,
								   const char *payloadJson) {
	@autoreleasepool {
		if (!elizaContactsHasAccess()) {
			return elizaCopyJson(elizaJsonError(
				@"permission", @"Apple Contacts access has not been granted."));
		}
		NSString *identifier = [elizaNSStringFromCString(personId)
			stringByTrimmingCharactersInSet:[NSCharacterSet
											 whitespaceAndNewlineCharacterSet]];
		NSDictionary *payload = elizaParseJsonObject(payloadJson);
		if ([identifier length] == 0 || payload == nil) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"Contact id and payload are required."));
		}
		CNContactStore *store = [[CNContactStore alloc] init];
		NSError *error = nil;
		CNContact *existing =
			[store unifiedContactWithIdentifier:identifier
									keysToFetch:elizaContactKeys()
										  error:&error];
		if (existing == nil || error != nil) {
			return elizaCopyJson(elizaJsonError(
				@"not_found",
				elizaErrorMessage(error, @"Apple contact was not found.")));
		}
		CNMutableContact *mutableContact = [existing mutableCopy];
		elizaApplyContactPayload(mutableContact, payload);
		CNSaveRequest *request = [[CNSaveRequest alloc] init];
		[request updateContact:mutableContact];
		error = nil;
		if (![store executeSaveRequest:request error:&error]) {
			return elizaCopyJson(elizaJsonError(
				@"native_error",
				elizaErrorMessage(error, @"Failed to update Apple contact.")));
		}
		return elizaCopyJson(elizaJsonOk(nil));
	}
}

extern "C" char *deleteContactJson(const char *personId) {
	@autoreleasepool {
		if (!elizaContactsHasAccess()) {
			return elizaCopyJson(elizaJsonError(
				@"permission", @"Apple Contacts access has not been granted."));
		}
		NSString *identifier = [elizaNSStringFromCString(personId)
			stringByTrimmingCharactersInSet:[NSCharacterSet
											 whitespaceAndNewlineCharacterSet]];
		if ([identifier length] == 0) {
			return elizaCopyJson(elizaJsonError(
				@"native_error", @"Contact id is required."));
		}
		CNContactStore *store = [[CNContactStore alloc] init];
		NSError *error = nil;
		CNContact *existing =
			[store unifiedContactWithIdentifier:identifier
									keysToFetch:elizaContactKeys()
										  error:&error];
		if (existing == nil || error != nil) {
			return elizaCopyJson(elizaJsonError(
				@"not_found",
				elizaErrorMessage(error, @"Apple contact was not found.")));
		}
		CNMutableContact *mutableContact = [existing mutableCopy];
		CNSaveRequest *request = [[CNSaveRequest alloc] init];
		[request deleteContact:mutableContact];
		error = nil;
		if (![store executeSaveRequest:request error:&error]) {
			return elizaCopyJson(elizaJsonError(
				@"native_error",
				elizaErrorMessage(error, @"Failed to delete Apple contact.")));
		}
		return elizaCopyJson(elizaJsonOk(nil));
	}
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

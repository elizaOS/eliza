/**
 * Standalone proof harness for transcript-view.mm: opens a real NSWindow with
 * behind-window vibrancy (the same layered-glass architecture as the desktop
 * shell), feeds it the committed golden transcript fixture through the exact
 * extern "C" surface the Bun FFI wrapper uses, exercises the action channel by
 * clicking a rendered choice chip, and writes PNG evidence.
 *
 * Not part of the shipped dylib — compiled together with transcript-view.mm
 * into a throwaway binary by the spike (see docs/native-glass-recon.md,
 * "Native transcript spike").
 *
 * Usage: transcript-spike-harness <golden-fixture.json> <evidence-dir>
 * Writes: <evidence-dir>/transcript-view-cachedisplay.png   (always — in-process
 *             AppKit render of the view hierarchy; vibrancy composites black
 *             here because WindowServer, not the app, draws the glass)
 *         <evidence-dir>/transcript-window-screencapture.png (only when the
 *             invoking terminal holds Screen Recording permission)
 */

#import <Cocoa/Cocoa.h>

extern "C" bool transcriptShow(void *windowPtr, const char *frameJson,
							   double x, double y, double w, double h);
extern "C" bool transcriptSetTranscript(void *windowPtr,
										const char *frameJson);
extern "C" bool transcriptHide(void *windowPtr);
extern "C" char *transcriptTakePendingAction(void);
extern "C" void transcriptFreeCString(char *value);

static void pumpRunLoop(NSTimeInterval seconds) {
	NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
	while ([deadline timeIntervalSinceNow] > 0) {
		NSEvent *event =
			[NSApp nextEventMatchingMask:NSEventMaskAny
							   untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]
								  inMode:NSDefaultRunLoopMode
								 dequeue:YES];
		if (event != nil) {
			[NSApp sendEvent:event];
		}
	}
}

static NSButton *findActionButton(NSView *view) {
	if ([NSStringFromClass([view class])
			isEqualToString:@"ElizaTranscriptActionButton"] &&
		[(NSButton *)view isEnabled]) {
		return (NSButton *)view;
	}
	for (NSView *subview in [view subviews]) {
		NSButton *found = findActionButton(subview);
		if (found != nil) {
			return found;
		}
	}
	return nil;
}

static NSScrollView *findTranscriptScrollView(NSView *view) {
	if ([view isKindOfClass:[NSScrollView class]] &&
		[[view identifier] isEqualToString:@"ElizaNativeTranscriptScroll"]) {
		return (NSScrollView *)view;
	}
	for (NSView *subview in [view subviews]) {
		NSScrollView *found = findTranscriptScrollView(subview);
		if (found != nil) {
			return found;
		}
	}
	return nil;
}

static bool writeContentViewPNG(NSView *contentView, NSString *path) {
	NSBitmapImageRep *rep =
		[contentView bitmapImageRepForCachingDisplayInRect:[contentView bounds]];
	if (rep == nil) {
		return false;
	}
	[contentView cacheDisplayInRect:[contentView bounds] toBitmapImageRep:rep];
	NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG
									properties:@{}];
	return png != nil && [png writeToFile:path atomically:YES];
}

int main(int argc, char **argv) {
	@autoreleasepool {
		if (argc < 3) {
			fprintf(stderr,
					"usage: transcript-spike-harness <fixture.json> <evidence-dir>\n");
			return 2;
		}
		NSString *fixturePath = [NSString stringWithUTF8String:argv[1]];
		NSString *evidenceDir = [NSString stringWithUTF8String:argv[2]];
		NSError *readError = nil;
		NSString *frameJson =
			[NSString stringWithContentsOfFile:fixturePath
									  encoding:NSUTF8StringEncoding
										 error:&readError];
		if (frameJson == nil) {
			fprintf(stderr, "failed to read fixture: %s\n",
					[[readError localizedDescription] UTF8String]);
			return 2;
		}
		[[NSFileManager defaultManager] createDirectoryAtPath:evidenceDir
								  withIntermediateDirectories:YES
												   attributes:nil
														error:nil];

		NSApplication *app = [NSApplication sharedApplication];
		[app setActivationPolicy:NSApplicationActivationPolicyAccessory];

		const CGFloat W = 520.0;
		const CGFloat H = 900.0;
		NSWindow *window = [[NSWindow alloc]
			initWithContentRect:NSMakeRect(240, 160, W, H)
					  styleMask:(NSWindowStyleMaskTitled |
								 NSWindowStyleMaskFullSizeContentView)
						backing:NSBackingStoreBuffered
						  defer:NO];
		[window setTitle:@"Native Transcript Spike"];
		[window setReleasedWhenClosed:NO];
		[window setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]];
		[window setTitlebarAppearsTransparent:YES];
		[window setBackgroundColor:[NSColor colorWithCalibratedWhite:0.05
															   alpha:1.0]];

		// Same glass layering the shell uses: NSVisualEffectView (behind-window)
		// below, transparent transcript list above.
		NSVisualEffectView *glass = [[NSVisualEffectView alloc]
			initWithFrame:[[window contentView] bounds]];
		[glass setMaterial:NSVisualEffectMaterialHUDWindow];
		[glass setBlendingMode:NSVisualEffectBlendingModeBehindWindow];
		[glass setState:NSVisualEffectStateActive];
		[glass setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
		[[window contentView] addSubview:glass];

		[window makeKeyAndOrderFront:nil];
		pumpRunLoop(0.3);

		bool shown = transcriptShow((__bridge void *)window,
									[frameJson UTF8String], 0, 0, W, H);
		printf("transcriptShow: %s\n", shown ? "ok" : "FAILED");
		if (!shown) {
			return 1;
		}
		pumpRunLoop(0.8);

		// Action-channel round trip: click the first enabled choice chip and
		// drain the queue — this is exactly what the Bun poller would receive.
		NSButton *chip = findActionButton([window contentView]);
		if (chip != nil) {
			[chip performClick:nil];
			pumpRunLoop(0.2);
			char *action = transcriptTakePendingAction();
			printf("action after chip click: %s\n",
				   action != nullptr ? action : "(none — FAILED)");
			if (action != nullptr) {
				transcriptFreeCString(action);
			}
		} else {
			printf("action after chip click: (no chip found — FAILED)\n");
		}
		char *empty = transcriptTakePendingAction();
		printf("queue drained: %s\n", empty == nullptr ? "ok" : "FAILED");
		if (empty != nullptr) {
			transcriptFreeCString(empty);
		}

		// transcriptSetTranscript refresh path (rebuild while mounted).
		bool refreshed =
			transcriptSetTranscript((__bridge void *)window,
									[frameJson UTF8String]);
		printf("transcriptSetTranscript: %s\n", refreshed ? "ok" : "FAILED");
		pumpRunLoop(0.5);

		// In-process capture of the transcript rows themselves (no Screen
		// Recording permission needed). The full contentView cacheDisplay
		// comes out blank — layer-backed chips + the vibrancy view don't
		// composite through cacheDisplayInRect — so capture the plain-view
		// document stack, which draws everything except the glass backdrop.
		NSString *cachePath = [evidenceDir
			stringByAppendingPathComponent:@"transcript-view-cachedisplay.png"];
		NSScrollView *captureScroll =
			findTranscriptScrollView([window contentView]);
		NSView *captureTarget = captureScroll != nil
			? [captureScroll documentView]
			: [window contentView];
		bool cached = writeContentViewPNG(captureTarget, cachePath);
		printf("cacheDisplay evidence: %s (%s)\n", cached ? "ok" : "FAILED",
			   [cachePath UTF8String]);

		NSString *scPath = [evidenceDir
			stringByAppendingPathComponent:
				@"transcript-window-screencapture.png"];
		NSString *command = [NSString
			stringWithFormat:@"/usr/sbin/screencapture -x -o -l %ld '%@' 2>/dev/null",
							 (long)[window windowNumber], scPath];
		system([command UTF8String]);
		bool captured =
			[[NSFileManager defaultManager] fileExistsAtPath:scPath] &&
			[[[NSFileManager defaultManager] attributesOfItemAtPath:scPath
															  error:nil]
				fileSize] > 0;
		printf("screencapture evidence: %s (%s)\n",
			   captured ? "ok" : "unavailable (Screen Recording permission)",
			   [scPath UTF8String]);

		// Second capture scrolled to the transcript top so the interactive
		// choice/permission chips are visible in evidence too.
		NSScrollView *scrollView =
			findTranscriptScrollView([window contentView]);
		if (scrollView != nil) {
			[[scrollView documentView] scrollPoint:NSMakePoint(0, 0)];
			pumpRunLoop(0.4);
			NSString *topPath = [evidenceDir
				stringByAppendingPathComponent:
					@"transcript-window-screencapture-top.png"];
			NSString *topCommand = [NSString
				stringWithFormat:
					@"/usr/sbin/screencapture -x -o -l %ld '%@' 2>/dev/null",
					(long)[window windowNumber], topPath];
			system([topCommand UTF8String]);
			printf("screencapture top evidence: %s (%s)\n",
				   [[NSFileManager defaultManager] fileExistsAtPath:topPath]
					   ? "ok"
					   : "unavailable",
				   [topPath UTF8String]);
		}

		bool hidden = transcriptHide((__bridge void *)window);
		printf("transcriptHide: %s\n", hidden ? "ok" : "FAILED");

		return cached ? 0 : 1;
	}
}

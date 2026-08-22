#import <EventKit/EventKit.h>
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <stdint.h>

using GenerationFunction = uint64_t (*)(void);

int main(int argc, const char *argv[]) {
	@autoreleasepool {
		if (argc != 2) return 2;
		void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
		if (library == nullptr) return 3;
		auto generation = reinterpret_cast<GenerationFunction>(
			dlsym(library, "appleCalendarEventStoreGeneration"));
		if (generation == nullptr) {
			dlclose(library);
			return 4;
		}

		uint64_t previous = generation();
		for (NSUInteger index = 0; index < 3; index += 1) {
			[[NSNotificationCenter defaultCenter]
				postNotificationName:EKEventStoreChangedNotification
							 object:nil];
			uint64_t current = generation();
			if (current <= previous) {
				dlclose(library);
				return 5;
			}
			previous = current;
		}

		dlclose(library);
		return 0;
	}
}

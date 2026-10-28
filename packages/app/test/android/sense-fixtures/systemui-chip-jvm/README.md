Hand-written host stubs of the Android, SystemUI and javax.inject APIs that the prepared
SystemUI Listening chip sources (android/aosp/listener/systemui/chip/source) call. They mirror the
signatures at the pinned AOSP revision from review, including hidden APIs SystemUI may use, so the
Java chip sources can be type-checked and the lease client exercised on a plain JVM
(test/aosp-listening-chip.test.mjs). Compiling against these stubs is not compiling SystemUI in the
pinned AOSP tree: signature drift, Dagger graph errors, resources and the Kotlin binder are only
caught by a real SystemUI build.

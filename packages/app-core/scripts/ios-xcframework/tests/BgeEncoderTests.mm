/** Exercises the linked iOS BGE bridge with the pinned real model and recorded desktop reference vectors supplied as XCTest resources. */
#import <XCTest/XCTest.h>
#import "ElizaBgeEncoder.h"
#include <cmath>

@interface BgeEncoderTests : XCTestCase
@property(nonatomic, strong) NSString *fixtureRoot;
@property(nonatomic, strong) NSString *modelPath;
@end
@implementation BgeEncoderTests
- (void)setUp {
    [super setUp];
    NSBundle *resources = [NSBundle bundleForClass:self.class];
    NSString *model = [resources pathForResource:@"bge-small-en-v1.5-f16" ofType:@"gguf"];
    XCTAssertNotNil(model, @"The test bundle must carry the actual pinned BGE model");
    self.fixtureRoot = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSError *error = nil;
    XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtPath:self.fixtureRoot withIntermediateDirectories:YES attributes:nil error:&error], @"%@", error);
    self.modelPath = [self.fixtureRoot stringByAppendingPathComponent:@"bge-small-en-v1.5-f16.gguf"];
    XCTAssertTrue(model && [NSFileManager.defaultManager copyItemAtPath:model toPath:self.modelPath error:&error], @"%@", error);
}
- (void)tearDown {
    NSError *error = nil;
    XCTAssertTrue([NSFileManager.defaultManager removeItemAtPath:self.fixtureRoot error:&error], @"%@", error);
    [super tearDown];
}
- (ElizaBgeEncoder *)openEncoder {
    NSError *error = nil;
    ElizaBgeEncoder *encoder = [ElizaBgeEncoder openModel:self.modelPath contextSize:512 error:&error];
    XCTAssertNotNil(encoder, @"%@", error);
    return encoder;
}
- (void)testCompleteInputAdmissionAndRelease {
    ElizaBgeEncoder *encoder = [self openEncoder];
    NSError *error = nil;
    NSMutableString *complete = [@"before" mutableCopy];
    [complete appendFormat:@"%C", (unichar)0];
    [complete appendString:@"after 😀 café 漢字"];
    NSDictionary *full = [encoder embedText:complete error:&error];
    XCTAssertNotNil(full, @"%@", error);
    NSDictionary *prefix = [encoder embedText:@"before" error:&error];
    XCTAssertGreaterThan([full[@"tokens"] integerValue], [prefix[@"tokens"] integerValue]);
    NSArray<NSNumber *> *a = full[@"embedding"], *b = prefix[@"embedding"];
    XCTAssertEqual(a.count, 384u);
    double difference = 0, norm = 0;
    for (NSUInteger i = 0; i < a.count; i++) {
        difference += std::pow(a[i].doubleValue - b[i].doubleValue, 2);
        norm += std::pow(a[i].doubleValue, 2);
    }
    XCTAssertGreaterThan(difference, 1e-6);
    XCTAssertEqualWithAccuracy(norm, 1.0, 1e-5);
    NSMutableString *boundary = [NSMutableString string];
    for (int i = 0; i < 510; i++) [boundary appendString:@"hello "];
    NSDictionary *accepted = [encoder embedText:boundary error:&error];
    XCTAssertNotNil(accepted, @"%@", error);
    XCTAssertEqual([accepted[@"tokens"] integerValue], 512);
    [boundary appendString:@"hello "];
    XCTAssertNil([encoder embedText:boundary error:&error]);
    XCTAssertEqualObjects(error.domain, @"EMBEDDING_INPUT_TOO_LARGE");
    [encoder close]; [encoder close];
    XCTAssertNil([encoder embedText:@"after release" error:&error]);
    XCTAssertEqualObjects(error.domain, @"EMBEDDING_CONTEXT_UNAVAILABLE");
    ElizaBgeEncoder *reloaded = [self openEncoder];
    XCTAssertNotNil([reloaded embedText:complete error:&error]);
    [reloaded close];
}
- (void)testDesktopVectorParity {
    NSString *file = [[NSBundle bundleForClass:self.class] pathForResource:@"bge-reference" ofType:@"json"];
    XCTAssertNotNil(file, @"Full recorded reference vectors are required");
    NSError *error = nil;
    NSData *data = file ? [NSData dataWithContentsOfFile:file options:0 error:&error] : nil;
    XCTAssertNotNil(data, @"%@", error);
    NSArray *rows = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
    XCTAssertEqual(rows.count, 4u, @"%@", error);
    ElizaBgeEncoder *encoder = [self openEncoder];
    for (NSDictionary *row in rows) {
        NSDictionary *result = [encoder embedText:row[@"input"] error:&error];
        XCTAssertNotNil(result, @"%@", error);
        NSArray<NSNumber *> *actual = result[@"embedding"], *reference = row[@"vector"];
        XCTAssertEqual(actual.count, reference.count);
        XCTAssertEqualObjects(result[@"embeddingSpace"], @"BAAI/bge-small-en-v1.5:cls:l2:384");
        double dot = 0, an = 0, rn = 0;
        for (NSUInteger i = 0; i < actual.count; i++) {
            dot += actual[i].doubleValue * reference[i].doubleValue;
            an += std::pow(actual[i].doubleValue, 2); rn += std::pow(reference[i].doubleValue, 2);
        }
        XCTAssertGreaterThan(dot / std::sqrt(an * rn), 0.99999);
    }
    [encoder close];
}
- (void)testArtifactAdmissionAndMalformedText {
    ElizaBgeEncoder *encoder = [self openEncoder];
    NSError *error = nil;
    unichar unpaired = 0xD800;
    NSString *malformed = [[NSString alloc] initWithCharacters:&unpaired length:1];
    XCTAssertNil([encoder tokenizeText:malformed error:&error]);
    XCTAssertEqualObjects(error.domain, @"EMBEDDING_INPUT_INVALID");
    [encoder close];
    NSString *nested = [[self.modelPath stringByAppendingString:@".embedding.bundle/text"] stringByAppendingPathComponent:@"alternate"];
    XCTAssertTrue([NSFileManager.defaultManager createDirectoryAtPath:nested withIntermediateDirectories:NO attributes:nil error:&error]);
    XCTAssertNil([ElizaBgeEncoder openModel:self.modelPath contextSize:512 error:&error]);
    XCTAssertEqualObjects(error.domain, @"EMBEDDING_ARTIFACT_INVALID");
    XCTAssertTrue([NSFileManager.defaultManager removeItemAtPath:nested error:&error]);
    XCTAssertTrue([@"corrupt model" writeToFile:self.modelPath atomically:YES encoding:NSUTF8StringEncoding error:&error]);
    XCTAssertNil([ElizaBgeEncoder openModel:self.modelPath contextSize:512 error:&error]);
    XCTAssertEqualObjects(error.domain, @"EMBEDDING_ARTIFACT_INVALID");
}
- (void)testConcurrentEmbeddingAndRelease {
    ElizaBgeEncoder *encoder = [self openEncoder];
    NSError *error = nil;
    NSString *text = @"Concurrent complete input 😀 café 漢字";
    NSDictionary *baseline = [encoder embedText:text error:&error];
    XCTAssertNotNil(baseline, @"%@", error);
    if (!baseline) return;
    NSMutableArray<NSDictionary *> *results = [NSMutableArray array];
    dispatch_queue_t queue = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
    dispatch_apply(24, queue, ^(size_t) {
        @autoreleasepool {
            NSError *callError = nil;
            NSDictionary *result = [encoder embedText:text error:&callError];
            @synchronized(results) {
                [results addObject:result ?: @{@"error": callError ?: NSNull.null}];
            }
        }
    });
    XCTAssertEqual(results.count, 24u);
    NSArray<NSNumber *> *reference = baseline[@"embedding"];
    for (NSDictionary *result in results) {
        XCTAssertNil(result[@"error"], @"%@", result[@"error"]);
        NSArray<NSNumber *> *vector = result[@"embedding"];
        XCTAssertEqual(vector.count, 384u);
        XCTAssertEqualObjects(result[@"tokens"], baseline[@"tokens"]);
        XCTAssertEqualObjects(result[@"embeddingSpace"], baseline[@"embeddingSpace"]);
        if (vector.count != reference.count) continue;
        for (NSUInteger i = 0; i < vector.count; i++) {
            XCTAssertEqualWithAccuracy(vector[i].doubleValue, reference[i].doubleValue, 1e-6);
        }
    }
    [results removeAllObjects];
    // Completion and release may win in either order, but every completed
    // request must be intact and every later request must be visibly rejected.
    dispatch_apply(16, queue, ^(size_t index) {
        @autoreleasepool {
            if (index % 2 == 0) {
                [encoder close];
            } else {
                NSError *callError = nil;
                NSDictionary *result = [encoder embedText:text error:&callError];
                @synchronized(results) {
                    [results addObject:result ?: @{@"error": callError ?: NSNull.null}];
                }
            }
        }
    });
    XCTAssertEqual(results.count, 8u);
    for (NSDictionary *result in results) {
        if (result[@"error"]) {
            XCTAssertTrue([result[@"error"] isKindOfClass:NSError.class]);
            if ([result[@"error"] isKindOfClass:NSError.class]) {
                XCTAssertEqualObjects(((NSError *)result[@"error"]).domain, @"EMBEDDING_CONTEXT_UNAVAILABLE");
            }
        } else {
            XCTAssertEqualObjects(result[@"tokens"], baseline[@"tokens"]);
            NSArray<NSNumber *> *vector = result[@"embedding"];
            XCTAssertEqual(vector.count, reference.count);
            if (vector.count == reference.count) {
                for (NSUInteger i = 0; i < vector.count; i++) {
                    XCTAssertEqualWithAccuracy(vector[i].doubleValue, reference[i].doubleValue, 1e-6);
                }
            }
        }
    }
    XCTAssertNil([encoder embedText:text error:&error]);
    XCTAssertEqualObjects(error.domain, @"EMBEDDING_CONTEXT_UNAVAILABLE");
    ElizaBgeEncoder *reopened = [self openEncoder];
    NSDictionary *recovered = [reopened embedText:text error:&error];
    XCTAssertNotNil(recovered, @"%@", error);
    XCTAssertEqualObjects(recovered[@"tokens"], baseline[@"tokens"]);
    [reopened close];
}
@end

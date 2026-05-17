import Foundation
@testable import ElizaMacCore
import XCTest

final class ElizaRepositoryResolverTests: XCTestCase {
    func testResolvesElizaRootFromNestedPath() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let nested = root.appendingPathComponent("packages/app-core/platforms/macos", isDirectory: true)

        try fileManager.createDirectory(at: nested, withIntermediateDirectories: true)
        fileManager.createFile(atPath: root.appendingPathComponent("package.json").path, contents: Data())
        try fileManager.createDirectory(at: root.appendingPathComponent("packages/app-core", isDirectory: true), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: root.appendingPathComponent("packages/agent", isDirectory: true), withIntermediateDirectories: true)
        fileManager.createFile(atPath: root.appendingPathComponent("packages/app-core/package.json").path, contents: Data())
        fileManager.createFile(atPath: root.appendingPathComponent("packages/agent/package.json").path, contents: Data())

        defer {
            try? fileManager.removeItem(at: root)
        }

        XCTAssertEqual(ElizaRepositoryResolver.resolve(startingAt: nested)?.path, root.path)
    }

    func testReturnsNilWhenNoElizaRootExists() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)

        defer {
            try? fileManager.removeItem(at: root)
        }

        XCTAssertNil(ElizaRepositoryResolver.resolve(startingAt: root))
    }
}

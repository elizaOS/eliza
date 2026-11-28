import Foundation

/// Native iOS **background `URLSession`** download for the large on-device
/// model pull (#11841).
///
/// The full-Bun runtime otherwise streams the ~5 GB Eliza-1 weight file to disk
/// with an in-process `fetch()`. iOS suspends that runtime the instant the app
/// backgrounds or the device locks, so the multi-GB transfer stalls at
/// "Loading eliza-1-2B…". A `URLSessionConfiguration.background` download task
/// is owned by the system `nsurlsessiond` daemon, not the app process, so it
/// keeps making progress while the app is suspended, survives a device lock,
/// and can relaunch the app on completion.
///
/// Contract with the JS downloader (`plugin-local-inference`): the downloader
/// drives this bridge synchronously through `host_call` —
/// `bg_download_start`, then it polls `bg_download_status` until the state is
/// terminal, and `bg_download_cancel` on user cancel. The bridge writes the
/// finished file to the exact `destPath` the downloader passed (its `.part`
/// staging path); the downloader then runs its existing sha256 verify + atomic
/// rename into the models directory. Progress and terminal state are reported
/// as plain values so the request/response `host_call` model needs no reverse
/// push channel.
///
/// State survives a process restart (Bun runtime crash/relaunch mid-transfer):
/// active-job metadata (`destPath`/`url`/`total`) and terminal outcomes are
/// persisted to `UserDefaults`, and outstanding background tasks are
/// re-associated by the OS when the session is recreated with the same
/// identifier — the delegate callbacks then rebuild in-memory state from the
/// persisted metadata keyed on `task.taskDescription`.
public final class BackgroundDownloadBridge: NSObject {
    /// Process-wide singleton — a background session identifier may only back a
    /// single live `URLSession` instance per process.
    public static let shared = BackgroundDownloadBridge()

    public enum DownloadState: String {
        case running
        case completed
        case failed
        case cancelled
    }

    private static let sessionIdentifier = "ai.eliza.bun.background-download"
    private static let persistenceKey = "ai.eliza.bun.background-download.state.v1"
    /// Bounded automatic resume attempts for a task that fails with recoverable
    /// resume data (transient network drop) before the job is surfaced as
    /// failed to the downloader.
    private static let maxAutoResumeAttempts = 5

    private final class JobState {
        let id: String
        var destPath: String
        var url: String
        var headers: [String: String]
        var received: Int64
        var total: Int64
        var state: DownloadState
        var error: String?
        var task: URLSessionDownloadTask?
        var resumeData: Data?
        var autoResumeAttempts: Int

        init(
            id: String,
            destPath: String,
            url: String,
            headers: [String: String],
            total: Int64
        ) {
            self.id = id
            self.destPath = destPath
            self.url = url
            self.headers = headers
            self.received = 0
            self.total = total
            self.state = .running
            self.error = nil
            self.task = nil
            self.resumeData = nil
            self.autoResumeAttempts = 0
        }
    }

    private let lock = NSLock()
    private var jobs: [String: JobState] = [:]
    private var backgroundCompletionHandler: (() -> Void)?

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(
            withIdentifier: Self.sessionIdentifier
        )
        // Relaunch the app in the background when tasks finish while it is
        // suspended so the completion handoff runs without user interaction.
        config.sessionSendsLaunchEvents = true
        // A user-initiated model install must not be deferred by the OS.
        config.isDiscretionary = false
        config.allowsCellularAccess = true
        config.waitsForConnectivity = true
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    override public init() {
        super.init()
        loadPersistedState()
        // Recreate the session eagerly so the OS re-associates any tasks that
        // outlived a previous app launch and starts delivering their delegate
        // callbacks (progress + completion) into this instance.
        _ = session
    }

    // MARK: - host_call surface

    /// Begin (or resume, or re-observe) a background download. Idempotent for a
    /// given `id`: a second call while the task is live returns the current
    /// snapshot instead of starting a duplicate transfer.
    public func start(
        id: String,
        urlString: String,
        headers: [String: String],
        destPath: String,
        expectedTotalBytes: Int64
    ) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }

        if let existing = jobs[id] {
            switch existing.state {
            case .running, .completed:
                return snapshot(existing)
            case .failed, .cancelled:
                // A prior terminal outcome for the same id is being retried —
                // fall through to (re)start, resuming from resume data if we
                // captured any.
                existing.state = .running
                existing.error = nil
                existing.destPath = destPath
                existing.url = urlString
                existing.headers = headers
                if expectedTotalBytes > 0 { existing.total = expectedTotalBytes }
                existing.autoResumeAttempts = 0
                startTask(for: existing)
                persistLocked()
                return snapshot(existing)
            }
        }

        let job = JobState(
            id: id,
            destPath: destPath,
            url: urlString,
            headers: headers,
            total: expectedTotalBytes
        )
        jobs[id] = job
        startTask(for: job)
        persistLocked()
        return snapshot(job)
    }

    public func status(id: String) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        guard let job = jobs[id] else {
            return ["state": DownloadState.failed.rawValue, "error": "unknown download id \(id)"]
        }
        return snapshot(job)
    }

    public func cancel(id: String) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        guard let job = jobs[id] else {
            return ["state": DownloadState.cancelled.rawValue, "cancelled": false]
        }
        job.task?.cancel()
        job.task = nil
        job.resumeData = nil
        job.state = .cancelled
        persistLocked()
        var result = snapshot(job)
        result["cancelled"] = true
        return result
    }

    /// AppDelegate relaunch hook: `application(_:handleEventsForBackgroundURLSession:completionHandler:)`
    /// forwards here so the completion handler is called once every queued
    /// delegate event has been delivered (`urlSessionDidFinishEvents`).
    public func handleEventsForBackgroundURLSession(
        identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == Self.sessionIdentifier else {
            completionHandler()
            return
        }
        lock.lock()
        backgroundCompletionHandler = completionHandler
        lock.unlock()
        // Touch the session so it re-associates outstanding tasks and flushes
        // their pending delegate callbacks.
        _ = session
    }

    // MARK: - task lifecycle (caller holds `lock`)

    private func startTask(for job: JobState) {
        let task: URLSessionDownloadTask
        if let resumeData = job.resumeData {
            task = session.downloadTask(withResumeData: resumeData)
            job.resumeData = nil
        } else {
            guard let url = URL(string: job.url) else {
                job.state = .failed
                job.error = "invalid download url"
                return
            }
            var request = URLRequest(url: url)
            for (key, value) in job.headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
            task = session.downloadTask(with: request)
        }
        task.taskDescription = job.id
        job.task = task
        job.state = .running
        task.resume()
    }

    private func job(forTaskDescription description: String?) -> JobState? {
        guard let description else { return nil }
        return jobs[description]
    }

    private func snapshot(_ job: JobState) -> [String: Any] {
        var result: [String: Any] = [
            "id": job.id,
            "state": job.state.rawValue,
            "received": NSNumber(value: job.received),
            "total": NSNumber(value: job.total),
            "destPath": job.destPath,
        ]
        if let error = job.error {
            result["error"] = error
        }
        return result
    }

    // MARK: - persistence

    private func persistLocked() {
        var payload: [String: [String: Any]] = [:]
        for (id, job) in jobs {
            var entry: [String: Any] = [
                "destPath": job.destPath,
                "url": job.url,
                "headers": job.headers,
                "received": NSNumber(value: job.received),
                "total": NSNumber(value: job.total),
                "state": job.state.rawValue,
            ]
            if let error = job.error { entry["error"] = error }
            payload[id] = entry
        }
        UserDefaults.standard.set(payload, forKey: Self.persistenceKey)
    }

    private func loadPersistedState() {
        guard
            let payload = UserDefaults.standard.dictionary(forKey: Self.persistenceKey)
                as? [String: [String: Any]]
        else { return }
        lock.lock()
        defer { lock.unlock() }
        for (id, raw) in payload {
            guard
                let destPath = raw["destPath"] as? String,
                let url = raw["url"] as? String
            else { continue }
            let headers = raw["headers"] as? [String: String] ?? [:]
            let total = (raw["total"] as? NSNumber)?.int64Value ?? 0
            let job = JobState(
                id: id,
                destPath: destPath,
                url: url,
                headers: headers,
                total: total
            )
            job.received = (raw["received"] as? NSNumber)?.int64Value ?? 0
            job.state = (raw["state"] as? String).flatMap(DownloadState.init) ?? .running
            job.error = raw["error"] as? String
            jobs[id] = job
        }
    }
}

extension BackgroundDownloadBridge: URLSessionDownloadDelegate {
    public func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        lock.lock()
        defer { lock.unlock() }
        guard let job = job(forTaskDescription: downloadTask.taskDescription) else { return }
        job.task = downloadTask
        job.received = totalBytesWritten
        if totalBytesExpectedToWrite > 0 {
            job.total = totalBytesExpectedToWrite
        }
        job.state = .running
    }

    public func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        // The temp file at `location` is deleted the moment this callback
        // returns, so the move to the destination must happen synchronously
        // here — before we hand control back to URLSession.
        lock.lock()
        let job = job(forTaskDescription: downloadTask.taskDescription)
        lock.unlock()
        guard let job else { return }

        let fileManager = FileManager.default
        let destURL = URL(fileURLWithPath: job.destPath)
        do {
            try fileManager.createDirectory(
                at: destURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if fileManager.fileExists(atPath: destURL.path) {
                try fileManager.removeItem(at: destURL)
            }
            try fileManager.moveItem(at: location, to: destURL)
        } catch {
            lock.lock()
            job.state = .failed
            job.error = "failed to stage downloaded file: \(error.localizedDescription)"
            persistLocked()
            lock.unlock()
            return
        }

        lock.lock()
        if let attributes = try? fileManager.attributesOfItem(atPath: destURL.path),
            let size = attributes[.size] as? NSNumber {
            job.received = size.int64Value
        }
        job.state = .completed
        job.task = nil
        job.error = nil
        persistLocked()
        lock.unlock()
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        lock.lock()
        defer { lock.unlock() }
        guard let job = job(forTaskDescription: task.taskDescription) else { return }
        // A successful transfer already flipped state to `.completed` in
        // `didFinishDownloadingTo`; nothing to do here.
        if job.state == .completed { return }
        guard let error else { return }

        let nsError = error as NSError
        if nsError.code == NSURLErrorCancelled {
            // An explicit cancel already set `.cancelled`; leave it.
            if job.state != .cancelled { job.state = .cancelled }
            job.task = nil
            persistLocked()
            return
        }

        // Recoverable failure: retry from resume data a bounded number of times
        // so a transient drop mid-transfer does not surface as a hard failure.
        if let resumeData = nsError.userInfo[NSURLSessionDownloadTaskResumeData] as? Data,
            job.autoResumeAttempts < Self.maxAutoResumeAttempts {
            job.resumeData = resumeData
            job.autoResumeAttempts += 1
            startTask(for: job)
            persistLocked()
            return
        }

        job.state = .failed
        job.error = error.localizedDescription
        job.task = nil
        // Preserve any resume data for a later explicit retry via `start`.
        job.resumeData = nsError.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        persistLocked()
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock()
        let handler = backgroundCompletionHandler
        backgroundCompletionHandler = nil
        lock.unlock()
        DispatchQueue.main.async {
            handler?()
        }
    }
}

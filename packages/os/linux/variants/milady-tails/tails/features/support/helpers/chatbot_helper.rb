class ChatBot
  def initialize(account, password, **opts)
    @account = account
    @password = password
    @opts = opts
    @pid = nil
  end

  def start
    cmd = [
      "#{GIT_DIR}/features/scripts/xmpp-bot",
      @account,
      @password,
    ]
    if @opts[:connect_server]
      cmd += ['--connect-server', @opts[:connect_server]]
    end
    cmd += ['--log-file', DEBUG_LOG_PSEUDO_FIFO]

    job = IO.popen(cmd)
    @pid = job.pid
  end

  def stop
    Process.kill('TERM', @pid)
    Process.wait(@pid)
  rescue StandardError
    # noop
  end

  def active?
    begin
      ret = Process.kill(0, @pid)
    rescue Errno::ESRCH => e
      return false if e.message == 'No such process'

      raise e
    end
    assert_equal(1, ret, "This shouldn't happen")
    true
  end
end

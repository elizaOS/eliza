require 'base64'
require 'json'
require 'socket'
require 'timeout'

module RemoteShell
  class ServerFailure < StandardError
  end

  # This exception is *only* supposed to be use internally in
  # communicate() -- in particular it must not be raised by a
  # Timeout.timeout() wrapping around communicate() or any use of it.
  class SocketReadTimeout < RuntimeError
  end

  # Used to differentiate vs Timeout::Error, which is thrown by
  # try_for() (by default) and often wraps around remote shell usage
  # -- in that case we don't want to catch that "outer" exception in
  # our handling of remote shell timeouts below.
  class Timeout < ServerFailure
  end

  DEFAULT_TIMEOUT = 20 * 60
  private_constant :DEFAULT_TIMEOUT

  # Counter providing unique id:s for each communicate() call.
  @@request_id ||= 0

  def communicate(vm, *args, **opts)
    opts[:timeout] ||= DEFAULT_TIMEOUT
    socket = UNIXSocket.new(vm.virtio_channel_socket_path(VIRTIO_REMOTE_SHELL))
    id = (@@request_id += 1)
    # Since we already have defined our own Timeout in the current
    # scope, we have to be more careful when referring to the Timeout
    # class from the 'timeout' module. However, note that we want it
    # to throw our own Timeout exception.
    Object::Timeout.timeout(opts[:timeout], Timeout) do
      socket.puts(JSON.dump([id] + args))
      socket.flush
      return if opts[:spawn]

      loop do
        # Calling socket.readline() and then just wait for the data to
        # arrive is prone to stalling for some reason. A timed read()
        # works much better.
        #
        # But timeouts introduce races: imagine if we time out after
        # reading the data from the socket, but before returning and
        # exiting the block; then the SocketReadTimeout is thrown and
        # we lose that data! However, if we limit the timed read to
        # only the first byte, which we always know what it's supposed
        # to be, then we can easily detect and correct this race.
        line_init = nil
        begin
          Object::Timeout.timeout(1, SocketReadTimeout) do
            line_init = socket.read(1)
          end
        rescue SocketReadTimeout
          next
        end
        if line_init != '['
          line_init = "[#{line_init}"
        end
        line = line_init + socket.readline("\n").chomp("\n")
        response_id, status, *rest = JSON.parse(line)
        if response_id == id
          if status != 'success'
            # rubocop:disable Style/GuardClause
            if (status == 'error') && rest.instance_of?(Array) && (rest.size == 1)
              msg = rest.first
              raise ServerFailure, msg.to_s
            else
              raise ServerFailure, "Uncaught exception: #{status}: #{rest}"
            end
            # rubocop:enable Style/GuardClause
          end
          return rest
        else
          debug_log('Dropped out-of-order remote shell response: ' \
                    "got id #{response_id} but expected id #{id}")
        end
      end
    end
  ensure
    socket.close if defined?(socket) && socket
  end

  module_function :communicate
  private :communicate

  class ShellCommand
    # If `:spawn` is false the server will block until it has finished
    # executing `cmd`, which in turn blocks the call of
    # `execute()`. Otherwise, if `:spawn` is true, there is no
    # blocking or even acknowledgement that the server received the
    # remote call. Spawning is useful when starting processes in the
    # background (or running scripts that does the same) or any
    # application we want to interact with. It is the caller's
    # responsibility to some how (even implicitly) verify that the
    # server executed the spawned command.
    def self.execute(vm, cmd, **opts)
      opts[:user] ||= 'root'
      opts[:spawn] = false unless opts.key?(:spawn)
      opts[:debug_log] = true unless opts.key?(:debug_log)
      opts[:env] ||= {}
      cmd_str = cmd
      unless opts[:env].empty?
        env_str = opts[:env].map { |k, v| "#{k}=#{v}" }.join(' ')
        cmd_str = "#{env_str} #{cmd_str}"
      end
      if opts[:spawn]
        type = 'sh_spawn'
        verb = 'spawning'
      else
        type = 'sh_call'
        verb = 'calling'
      end

      if opts[:debug_log]
        debug_log("Remote shell: #{verb} as #{opts[:user]}: #{cmd_str}")
      end

      args = [type, opts[:user], opts[:env], cmd]
      ret = RemoteShell.communicate(vm, *args, **opts)
      if opts[:debug_log] && !(opts[:spawn])
        debug_log("Remote shell: #{type} returned: #{ret}")
      end
      ret
    end

    attr_reader :cmd, :returncode, :stdout, :stderr

    def initialize(vm, cmd, **opts)
      @cmd = cmd
      @returncode, @stdout, @stderr = self.class.execute(vm, cmd, **opts)
    end

    def success?
      @returncode.zero?
    end

    def failure?
      !success?
    end

    def to_s
      "Return status: #{@returncode}\n" \
        "STDOUT:\n#{@stdout}" \
        "STDERR:\n#{@stderr}"
    end
  end

  class PythonCommand
    def self.execute(vm, code, **opts)
      opts[:user] ||= 'root'
      opts[:debug_log] = true unless opts.key?(:debug_log)
      opts[:env] ||= {}
      show_code = code.chomp
      if show_code["\n"]
        indented_lines = show_code.lines
                                  .map { |l| ' ' * 4 + l.chomp }
                                  .join("\n")
        show_code = "\n#{indented_lines}"
      end

      if opts[:debug_log]
        if !opts[:env].empty?
          env_str = opts[:env].map { |k, v| "#{k}=#{v}" }.join(' ')
          debug_log("executing Python as #{opts[:user]} with #{env_str}: #{show_code}")
        else
          debug_log("executing Python as #{opts[:user]}: #{show_code}")
        end
      end
      ret = RemoteShell.communicate(
        vm, 'python_execute', opts[:user], opts[:env], code, **opts
      )
      debug_log('execution complete') if opts[:debug_log]
      ret
    end

    attr_reader :code, :exception, :stdout, :stderr

    def initialize(vm, code, **opts)
      @code = code
      @exception, @stdout, @stderr = self.class.execute(vm, code, **opts)
    end

    def success?
      @exception.nil?
    end

    def failure?
      !success?
    end

    def to_s
      "Exception: #{@exception}\n" \
        "STDOUT:\n#{@stdout}" \
        "STDERR:\n#{@stderr}"
    end
  end

  class SignalReady
    def self.execute(vm)
      RemoteShell.communicate(vm, 'signal_ready')
    end

    attr_reader :returncode, :stdout, :stderr

    def initialize(vm)
      @returncode, @stdout, @stderr = self.class.execute(vm)
    end

    def success?
      @exception.nil?
    end

    def failure?
      !success?
    end

    def to_s
      "Exception: #{@exception}\n" \
        "STDOUT:\n#{@stdout}" \
        "STDERR:\n#{@stderr}"
    end
  end

  # An IO-like object that is more or less equivalent to a File object
  # opened in rw mode.
  class File
    def self.open(vm, mode, path, *args, **opts)
      debug_log("opening file #{path} in '#{mode}' mode")
      ret = RemoteShell.communicate(vm, "file_#{mode}", path, *args, **opts)
      if ret.size != 1
        raise ServerFailure, "expected 1 value but got #{ret.size}"
      end

      debug_log("#{mode} complete")
      ret.first
    end

    attr_reader :vm, :path

    def initialize(vm, path)
      @vm = vm
      @path = path
    end

    def read
      Base64.decode64(
        self.class.open(@vm, 'read', @path)
      ).force_encoding('utf-8')
    end

    def write(data)
      self.class.open(@vm, 'write', @path, Base64.encode64(data))
    end

    def append(data)
      self.class.open(@vm, 'append', @path, Base64.encode64(data))
    end
  end
end

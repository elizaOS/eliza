require 'singleton'
require 'socket'

# This singleton class is used for starting a thread that continuously
# receives the guest's journal over a virtio channel, dumping it to a
# file to be used as an artifact in case of failure. The primary
# reason of this approach is for being able to investigate issues with
# the remote shell, which otherwise could be used for fetching the
# journal. In fact, since we stream the journal continuously we will
# even have a journal if the guest crashes, and the end of the journal
# might have clues about what happened.

# Note that some care has to be taken when it comes to snapshots:
# after restoring from a snapshot that was created during another
# scenario, any journal entries from before that snapshot was saved
# are lost during the current scenario. So it has to be restarted
# after restoring from a snapshot, and on the guest end it has to
# re-send the full journal (detected by the socket is closing).
class JournalDumper
  include Singleton

  attr_accessor :path

  def start
    stop unless @thread.nil?
    socket_path = $vm.virtio_channel_socket_path(VIRTIO_JOURNAL_DUMPER)
    @path ||= "#{$config['TMPDIR']}/artifact.journal"
    debug_log("Starting journal dumper thread, dumping to #{@path}")
    @thread = Thread.new do
      Thread.current.report_on_exception = false
      UNIXSocket.open(socket_path) do |socket|
        File.open(@path, 'w') do |journal|
          until socket.closed?
            journal.write(socket.readline.force_encoding('UTF-8'))
            journal.flush
          end
        end
      end
    end
  end

  def stop
    @thread&.kill
  end
end

=head1 NAME

Tails::IUK::Frontend - lead Tails user through the process of upgrading the system, if needed

=cut

package Tails::IUK::Frontend;

use 5.10.1;
use strictures 2;

use autodie qw(:all);
use Carp;
use Carp::Assert;
use Carp::Assert::More;
use English qw{-no_match_vars};
use Env;
use Function::Parameters;
use IPC::Run;
use List::Util qw(reduce);
use Locale::Messages qw{bind_textdomain_codeset
                        bind_textdomain_filter
                        turn_utf_8_on};
use Path::Tiny;
use POSIX;
use String::Errf qw{errf};
use Tails::Download::HTTPS;
use Tails::RunningSystem;
use Tails::IUK::DownloadProgress;
use Tails::IUK::UpgradeDescriptionFile;
use Tails::IUK::Utils qw{space_available_in};
use Try::Tiny;
use Types::Path::Tiny qw{AbsDir AbsFile};
use Types::Standard qw(ArrayRef Bool CodeRef Defined HashRef InstanceOf Int Maybe Str Object);

BEGIN {
    bind_textdomain_filter 'tails', \&turn_utf_8_on;
    bind_textdomain_codeset 'tails', 'utf-8';
}

no Moo::sification;
use Moo;
use MooX::HandlesVia;

with 'Tails::Role::HasEncoding';
with 'Tails::IUK::Role::FormatByte';

use namespace::clean;

# Must be after namespace::clean, so that we can use "around" for the "__"
# function.
use Locale::TextDomain 'tails';

use MooX::Options;

# Workaround the fact MooX::Options is incompatible with Locale::TextDomain
# (it needs a __ method, which it injects via MooX::Locale::Passthrough,
# but that does not go well when Locale::TextDomain is loaded).
around __ => sub {
    my $orig = shift;
    # if called as a class or object method,
    # let's ignore the second argument ($self)
    shift if ref $_[0] or $_[0] eq __PACKAGE__;
    my $msgid = shift;
    Locale::TextDomain::__($msgid);
};

=head1 ATTRIBUTES

=cut

option "override_$_" => (
    is        => 'lazy',
    isa       => Str,
    format    => 's',
    predicate => 1,
) for (qw{baseurl build_target signing_key});

option override_initial_install_os_release_file =>
    is        => 'lazy',
    isa       => AbsFile,
    coerce    => AbsFile->coercion,
    format    => 's',
    predicate => 1;

option override_os_release_file =>
    is        => 'lazy',
    isa       => AbsFile,
    coerce    => AbsFile->coercion,
    format    => 's',
    predicate => 1;

option "override_$_" => (
    isa        => AbsDir,
    is         => 'ro',
    lazy_build => 1,
    coerce     => AbsDir->coercion,
    format     => 's',
    predicate  => 1,
) for (qw{dev_dir liveos_mountpoint proc_dir run_dir});

option report_no_upgrade =>
    is       => 'lazy',
    isa      =>  Bool;

option batch =>
    is  => 'lazy',
    isa => Bool;

option 'override_started_from_device_installed_with_tails_installer' =>
    is            => 'lazy',
    isa           => Str,
    format        => 's',
    predicate     => 1,
    documentation => q{Internal, for test suite only};

has 'running_system' =>
    is      => 'lazy',
    isa     => InstanceOf['Tails::RunningSystem'],
    handles => [
        qw{product_name build_target}
    ];

has 'free_space' =>
    is            => 'lazy',
    isa           => Int,
    documentation => q{Free space (in bytes) on the system partition};

option 'override_free_space' =>
    is            => 'lazy',
    isa           => Int,
    format        => 'i',
    predicate     => 1,
    documentation => q{Internal, for test suite only};

has 'new_signing_key' =>
    is        => 'rw',
    isa       => AbsFile,
    predicate => 1;

=head1 CONSTRUCTORS AND BUILDERS

=cut

method _build_batch () { 0; }

method _build_report_no_upgrade () { 0; }

method _build_running_system () {
    my @args;
    for (qw{baseurl build_target dev_dir liveos_mountpoint},
         qw{os_release_file initial_install_os_release_file},
         qw{proc_dir run_dir}) {
        my $attribute = "override_$_";
        my $predicate = "has_$attribute";
        if ($self->$predicate) {
            push @args, ($_ => $self->$attribute)
        }
    }
    if ($self->has_override_started_from_device_installed_with_tails_installer) {
        push @args, (
            override_started_from_device_installed_with_tails_installer
                => $self->override_started_from_device_installed_with_tails_installer
        );
    }
    Tails::RunningSystem->new(@args);
}

method _build_free_space () {
    $self->has_override_free_space
        ? $self->override_free_space
        : space_available_in($self->running_system->liveos_mountpoint);
}

=head1 METHODS

=cut

method fatal (Str $msg, Str :$title, Str :$debugging_info = '') {
    say STDERR $self->encoding->encode("$title\n$msg\n$debugging_info");
    $self->dialog($msg, type => 'error', title => $title) unless $self->batch;
    croak($self->encoding->encode("$title\n$msg\n$debugging_info"));
}

method info (Str $msg) {
    say $self->encoding->encode($msg);
}

method fatal_run_cmd (Str :$error_msg, ArrayRef :$cmd, Maybe[Str] :$as = undef, Str :$error_title) {
    my @cmd       = @{$cmd};

    if (defined $as && ! $ENV{HARNESS_ACTIVE}) {
        @cmd = ('sudo', '-n', '-u', $as, @cmd);
    }

    my ($stdout, $stderr);
    my $success = 0;
    my $exit_code;
    $success = 1 if IPC::Run::run \@cmd, '>', \$stdout, '2>', \$stderr;
    $exit_code = $?;
    $success or $self->fatal(
        "<b>$error_msg</b>",
        title          => $error_title,
        debugging_info => $self->encoding->decode(errf(
            "exit code: %{exit_code}i\n\n".
            "stdout:\n%{stdout}s\n\n".
            "stderr:\n%{stderr}s",
            { exit_code => $exit_code, stdout => $stdout, stderr => $stderr },
        )),
    );

    return ($stdout, $stderr, $success, $exit_code);
}

method init_zenity_progress_dialog_text ((InstanceOf['Tails::IUK::DownloadProgress']) $download_progress) {
    # Zenity doesn't resize the width of the progress
    # dialog if a text is bigger than the initial text.
    # So let's give to the progress dialog initial text
    # a value that avoids zenity break download_progress->info
    # into a new line.


    my $time_left_str = reduce {length $a > length $b ? $a : $b} map {
        my $time_key  = $_;
        my $max_time  = $time_key eq 'hour' ? 23 : 59;
        map {
            $download_progress->time_duration->{$time_key}->($_)
        }1 .. $max_time;
    } qw{second minute hour day};
    $time_left_str =  $time_left_str . ' ' . $time_left_str;

    my $byte_unit = reduce {length $a > length $b ? $a : $b} map {
        $self->format_bytes(1024**$_)}0 .. 3;
    $byte_unit =~ s/\d+//;

    my $big_str       = '000000' . $byte_unit;
    my $init_text     = $download_progress->info;
    my $size_left_str = $self->format_bytes($download_progress->last_byte_downloaded);
    my $unknow_str    = $download_progress->estimated_end_time;

    $init_text =~ s/\Q$unknow_str\E/$time_left_str/;
    $init_text =~ s/\Q$size_left_str\E/$big_str/;
    $init_text =~ s/\(0.+\//($big_str\//;

    $init_text = $download_progress->info
        if length ($download_progress->info) > length($init_text);

    return $init_text;
}

method dialog (Str $question, Str :$type = 'question', Str :$title,
               Maybe[Str] :$ok_label = undef, Maybe[Str] :$cancel_label = undef,
               Maybe[Bool] :$default_cancel = undef,
           ) {
    if ($type ne 'question' && $type ne 'info') {
        assert_undefined($ok_label);
    }
    if ($type ne 'question') {
        assert_undefined($cancel_label);
        assert_undefined($default_cancel);
    }
    my @cmd  = ('zenity', "--$type", '--text', $question);
    my $info = $question;
    if (defined $title) {
        $info = "$title\n$info";
        push @cmd, ('--title', $title);
    }
    if (defined $ok_label) {
        $info = "$info: $ok_label";
        push @cmd, ('--ok-label', $ok_label);
    }
    if (defined $cancel_label) {
        $info = "$info / $cancel_label";
        push @cmd, ('--cancel-label', $cancel_label);
    }
    push @cmd, '--default-cancel' if $default_cancel;
    $self->info($info);
    return 1 if $self->batch;
    system([0,1], @cmd);
    ${^CHILD_ERROR_NATIVE} == 0;
}

method upgrader_run_dir () {
    $self->running_system->run_dir->child('tails-upgrader');
}

method checked_upgrades_file () {
    $self->upgrader_run_dir->child('checked_upgrades');
}

method refresh_signing_key () {
    my ($error_msg, $new_key_content);
    $error_msg =
        __(
            q{<b>An error occurred while updating the signing key.</b>\n\n}.
            q{<b>This prevents determining whether an upgrade is available from our website.</b>\n\n}.
            q{Check your network connection and restart Tails.\n\n}.
            q{If the problem persists, try doing a manual upgrade.},
        );
    try {
        $new_key_content = Tails::Download::HTTPS->new(
            max_download_size => 128 * 2**10,
            )->get_url(
                $self->running_system->baseurl . '/tails-signing-minimal.key'
            );
    } catch {
        $self->fatal(
            $error_msg,
            title => __(q{Error while downloading the signing key}),
            debugging_info => $self->encoding->decode($_),
        );
    };
    my $new_signing_key = Path::Tiny->tempfile;
    $new_signing_key->spew($new_key_content);
    $self->new_signing_key($new_signing_key);
}

method get_upgrade_description () {
    my @args;

    for (qw{baseurl build_target os_release_file initial_install_os_release_file}) {
        my $attribute = "override_$_";
        my $predicate = "has_$attribute";
        if ($self->$predicate) {
            my $arg = "--$attribute";
            push @args, ($arg, $self->$attribute);
        }
    }
    if ($self->has_override_signing_key) {
        push @args, (
            '--signing_key', $self->override_signing_key
        );
    }

    $self->has_new_signing_key or croak("Assertion failed: missing new_signing_key");
    push @args, (
        '--extra_signing_key', $self->new_signing_key
    );

    my ($stdout, $stderr, $success, $exit_code) = $self->fatal_run_cmd(
        cmd         => [ 'tails-iuk-get-upgrade-description-file', @args ],
        error_title => __(q{Error while checking for upgrades}),
        error_msg   => __(
            "<b>Could not determine whether an upgrade is available from our website.</b>\n\n".
            "Check your network connection and restart Tails.\n\n".
            "If the problem persists, try doing a manual upgrade.",
    ));

    return ($stdout, $stderr, $success, $exit_code);
}

method no_incremental_explanation (Str $no_incremental_reason) {
    assert_defined($no_incremental_reason);

    my $explanation;

    if ($no_incremental_reason eq 'no-incremental-upgrade-path') {
        $explanation = __(
            q{no automatic upgrade is available from our website }.
            q{for this version}
        );
    }
    elsif ($no_incremental_reason eq 'not-installed-with-tails-installer') {
        $explanation = __(
            q{your device was not created using a USB image or Tails Cloner}
        );
    }
    elsif ($no_incremental_reason eq 'non-writable-device') {
        $explanation = __(
            q{Tails was started from a DVD or a read-only device}
        );
    }
    elsif ($no_incremental_reason eq 'not-enough-free-space') {
        $explanation = __(
            q{there is not enough free space on the Tails system partition}
        );
    }
    elsif ($no_incremental_reason eq 'not-enough-free-memory') {
        $explanation = __(
            q{not enough memory is available on this system}
        );
    }
    else {
        say STDERR __x(
                q{No explanation available for reason '{reason}'.},
                reason => $no_incremental_reason,
        );
        $explanation = $no_incremental_reason;
    }

    return "$explanation";
}

method run () {
    $self->refresh_signing_key;
    my ($upgrade_description_text) = $self->get_upgrade_description;
    my ($upgrade_description, $upgrade_path, $upgrade_type, $no_incremental_reason);
    try {
        $upgrade_description = Tails::IUK::UpgradeDescriptionFile->new_from_text(
        text            => $upgrade_description_text,
        product_version => $self->running_system->product_version,
       );
        assert_isa($upgrade_description, 'Tails::IUK::UpgradeDescriptionFile');

        $self->checked_upgrades_file->touch;

        unless ($upgrade_description->contains_upgrade_path) {
          $self->info(__("The system is up-to-date"));
          $self->dialog(
              __(
                  "You are currently running the latest version. There is no upgrade available.\n"
              ),
              type     => 'info',
              title    => __(q{Tails is up to date}),
          ) if $self->report_no_upgrade ;
          exit(0);
        }

        $self->info(__(
                        'This version of Tails is outdated, and may have security issues.'
        ));

        if ($self->running_system->started_from_writable_device) {
            if ($self->running_system->started_from_device_installed_with_tails_installer) {
                $upgrade_description->contains_incremental_upgrade_path or
                    $no_incremental_reason = 'no-incremental-upgrade-path';
            }
            else {
                $no_incremental_reason = 'not-installed-with-tails-installer';
            }
        }
        else {
            $no_incremental_reason = 'non-writable-device';
        }

        if (! defined($no_incremental_reason)) {
            my $incremental_upgrade_path = $upgrade_description->incremental_upgrade_path;
            my $free_memory             = $self->running_system->free_memory;
            my $memory_needed           = memory_needed($incremental_upgrade_path);
            if ($free_memory >= $memory_needed) {
                my $free_space   = $self->free_space;
                my $space_needed = space_needed($incremental_upgrade_path);
                if ($free_space >= $space_needed) {
                    $upgrade_path = $incremental_upgrade_path;
                    $upgrade_type = 'incremental';
                }
                else {
                    $no_incremental_reason = 'not-enough-free-space';
                    $self->info(__x(
                                    "The available incremental upgrade requires ".
                                    "{space_needed} ".
                                    "of free space on Tails system partition, ".
                                    " but only {free_space} is available.",
                                    space_needed => $self->format_bytes($space_needed),
                                    free_space   => $self->format_bytes($free_space),
                    ));
                }
            }
            else {
                $no_incremental_reason = 'not-enough-free-memory';
                $self->info(__x(
                                "The available incremental upgrade requires ".
                                "{memory_needed} of free memory, but only ".
                                "{free_memory} is available.",
                                memory_needed => $self->format_bytes($memory_needed),
                                free_memory   => $self->format_bytes($free_memory),
                ));
            }
        }
    } catch {
        $self->fatal(
            __(
                "An error occurred while detecting available upgrades.\n".
                "This should not happen. Please report a bug.",
            ),
            title => __(q{Error while detecting available upgrades}),
            debugging_info => $self->encoding->decode($_),
        );
    };

    # incremental upgrade is not available or possible,
    # let's see if we can do a full upgrade
    if (! defined($upgrade_path)) {
        if ($upgrade_description->contains_full_upgrade_path) {
            $upgrade_path = $upgrade_description->full_upgrade_path;
            $upgrade_type = 'full';
        }
        else {
            $self->fatal(
                __(
                    "An incremental upgrade is available, but no full upgrade is.\n".
                    "This should not happen. Please report a bug."
                ),
                title => __(
                    q{Error while detecting available upgrades}
                ),
            );
        }
    }

    if ($upgrade_type eq 'incremental') {
        exit(0) unless($self->dialog(
            __x(
                "<b>You should upgrade to {name} {version}.</b>\n\n".
                "For more information about this new version, go to {details_url}\n\n".
                "We recommend you close all other applications during the upgrade.\n".
                "Downloading the upgrade might take a long time, from several minutes to a few hours.\n\n".
                 "Download size: {size}\n\n".
                 "Do you want to upgrade now?",
                details_url => $upgrade_path->{'details-url'},
                name        => $upgrade_description->product_name,
                version     => $upgrade_path->{version},
                size        => $self->format_bytes(
                    $upgrade_path->{'total-size'}
                ),
            ),
            title          => __(q{Upgrade available}),
            ok_label       => __(q{Upgrade now}),
            cancel_label   => __(q{Upgrade later}),
            default_cancel => 1,
            ));
        $self->do_incremental_upgrade($upgrade_path);
    }
    else {
        exit(0) unless($self->dialog(
            __x(
                "<b>You should do a manual upgrade to the latest version of {name}.</b>\n\n".
                "For more information about this new version, go to {details_url}\n\n".
                "It is impossible to do an automatic upgrade of ".
                "your Tails to this new version: {explanation}.\n\n".
                "To learn how to do a manual upgrade, go to {manual_upgrade_url}",
                details_url        => q{https://tails.net/latest},
                name               => $upgrade_description->product_name,
                explanation        => $self->no_incremental_explanation($no_incremental_reason),
                manual_upgrade_url => 'https://tails.net/doc/upgrade/#manual',
            ),
            title => __(q{New version available}),
            type  => 'info',
        ));
        $self->do_full_upgrade($upgrade_path);
    }
}

fun target_files (HashRef $upgrade_path, AbsDir $destdir) {
    my @target_files;
    foreach my $target_file (@{$upgrade_path->{'target-files'}}) {
        my $basename    = path($target_file->{url})->basename;
        my $output_file = path($destdir, $basename);
        push @target_files,
            {
                %{$target_file},
                output_file => $output_file,
            };
    }

    return @target_files;
}

=head2 memory_needed

Returns the amount of free RAM, in bytes, needed to download and install
the incremental upgrade described in the upgrade path passed
as argument.

=cut
fun memory_needed (HashRef $upgrade_path) {
    # We need:
    #  - The size of the target file, because tails-iuk-get-target-file
    #    will download in a temporary directory stored in the root filesystem's
    #    union upper branch, that is in a tmpfs, that is in memory.
    #  - Enough memory to run the tails-iuk-get-target-file process.
    #  - Enough memory to run the tails-install-iuk process.
    #  - Some margin, e.g. for the squashfs kernel module to decompress
    #    the IUK when we copy its content to the system partition.
    my $get_target_file_process_memory = 60 * 1024 * 1024;
    my $install_iuk_process_memory = 90 * 1024 * 1024;
    my $margin = 64 * 1024 * 1024;

    $upgrade_path->{'total-size'}
        + $get_target_file_process_memory
        + $install_iuk_process_memory
        + $margin;
}

=head2 space_needed

Returns the amount of free space, in bytes, needed on the system
partition to download and install the incremental upgrade described in
the upgrade path passed as argument.

=cut
fun space_needed (HashRef $upgrade_path) {
    # At this point, we only know the size of the target file,
    # which is an IUK, i.e. a (compressed) SquashFS, whose content
    # will be copied to the system partition: vmlinuz, initrd; EFI,
    # isolinux, and utils directories; SquashFS diff.
    #
    # So the question basically boils down to: how well is the IUK
    # compressed?
    #
    # In practice, in most cases the total size of the IUK content is
    # dominated by the size of the SquashFS diff and the initrd, which
    # are already heavily compressed and won't be compressed further
    # in the IUK. So in most cases, we only need to leave room for
    # a tiny bit of margin, hence a $space_factor not much bigger
    # than 1 should do the job.
    #
    # Still, let's give ourselves a bit of margin, in the form or an
    # additional constant, just in case, for whatever reason, we ever
    # generate an IUK whose content is mostly uncompressed data,
    # and our $space_factor is not sufficient in itself.
    my $space_factor = 1.2;
    my $space_margin = 64 * 1024;
    $space_factor * $upgrade_path->{'total-size'} + $space_margin;
}

method get_target_files (HashRef $upgrade_path, AbsDir $destdir) {
    my $title = __("Downloading upgrade");
    my $info = __x(
        "Downloading the upgrade to {name} {version}...",
        name    => $self->product_name,
        version => $upgrade_path->{version},
    );
    $self->info($info);

    foreach my $target_file (target_files($upgrade_path, $destdir)) {
        my @cmd = (
            'tails-iuk-get-target-file',
            '--uri',          $target_file->{url},
            '--hash_type',    'sha256',
            '--hash_value',   $target_file->{sha256},
            '--size',         $target_file->{size},
            '--output_file',  $target_file->{output_file},
        );
        if (! $ENV{HARNESS_ACTIVE}) {
            @cmd = ('sudo', '-n', '-u', 'tails-iuk-get-target-file', @cmd);
        }
        my ($exit_code, $stderr);
        my $success = 0;

        if ($self->batch) {
            $success = 1 if IPC::Run::run \@cmd, '2>', \$stderr;
            $exit_code = $?;
        }
        else {
            my ($download_h, $zenity_h, $download_out, $zenity_in);
            my ($bytes_downloaded, $percent_complete);
            my $download_progress =
                Tails::IUK::DownloadProgress->new(size => $target_file->{size});
            $info = $self->init_zenity_progress_dialog_text($download_progress);
            $download_h =  IPC::Run::start \@cmd,
                \undef, \$download_out, '2>', \$stderr;
            $zenity_h = IPC::Run::start
                [
                    qw{zenity --progress --percentage=0},
                    '--title', $title, '--text', $info
                ],
                \$zenity_in;
            try {
                while ($zenity_h->pumpable && $download_h->pumpable ) {
                    # Zenity reads data from standard input line by line.
                    # If a line is prefixed with # the text is updated with the text on that line.
                    # If a line contains only a number, the percentage is updated with that number.

                    ### Get download progress percentage
                    $download_h->pump;
                    next unless $download_out;

                    ### Update the progress dialog bar percentage
                    $zenity_in = $download_out;
                    $zenity_h->pump_nb;

                    ### Update the progress dialog text

                    ($percent_complete) = split /\n/, $download_out;

                    # Convert percentage to total number of bytes downloaded
                    $bytes_downloaded = ($percent_complete/100) * $download_progress->size;
                    # Clear $download_out to avoid old output in the next iteration
                    $download_out = undef;

                    next unless $download_progress->update($bytes_downloaded);

                    # Send up-to-date progress dialog text to zenity
                    $zenity_in = $download_progress->info;
                    $zenity_h->pump_nb;
                }
            }
            catch {
                $stderr = $_;
                $self->info("Caught exception, cancelling download:\n$stderr");
                $self->cancel_download;
            }
            finally {
                $self->info("Killing zenity");
                $zenity_h->kill_kill;
                my $zenity_result = $zenity_h->result;
                if ($zenity_result) {
                    $self->info("zenity returned non-zero, cancelling download: $zenity_result");
                    $self->cancel_download;
                    kill TERM => -getpgrp();
                }
                else {
                    $success =  $download_h->finish;
                    $exit_code = $download_h->result;
                }
            };
        }
        $success and defined $exit_code and $exit_code == 0 or $self->fatal(
            __(
                q{<b>The upgrade could not be downloaded.</b>\n\n}.
                q{Check your network connection, and restart Tails to try upgrading again.}
            ),
            title => __(q{Error while downloading the upgrade}),
            debugging_info => $self->encoding->decode(errf(
                "exit code: %{exit_code}i\n\n".
                "stderr:\n%{stderr}s",
                { exit_code => $exit_code, stderr => $stderr }
            )),
        );

        -e $target_file->{output_file} or $self->fatal(
            __x(
                q{Output file '{output_file}' does not exist, but }.
                q{tails-iuk-get-target-file did not complain. }.
                q{Please report a bug.},
                output_file => $target_file->{output_file},
            ),
            title => __(q{Error while downloading the upgrade}),
        );
    }
}

method do_incremental_upgrade (HashRef $upgrade_path) {
    my ($stdout, $stderr, $success, $exit_code);

    my ($target_files_tempdir) = $self->fatal_run_cmd(
        cmd       => ['tails-iuk-mktemp-get-target-file'],
        error_title => __(
            q{Error while creating temporary downloading directory}
        ),
        error_msg => __(
            "Failed to create temporary download directory"
        ),
        as        => 'tails-iuk-get-target-file',
    );
    chomp $target_files_tempdir;

    $self->get_target_files(
        $upgrade_path, path($target_files_tempdir)
    );

    $self->dialog(
        __(
            "The upgrade was successfully downloaded.\n\n".
            "The network connection will be disabled when applying the upgrade.\n\n".
            "Please save your work and close all other applications."
        ),
        type     => 'info',
        title    => __(q{Upgrade successfully downloaded}),
        ok_label => __(q{Apply upgrade}),
    );

    $self->install_iuk($upgrade_path, path($target_files_tempdir));

    $self->dialog(
        __(
            "<b>Your Tails device was successfully upgraded.</b>\n\n".
            "Some security features were temporarily disabled.\n".
            "You should restart Tails on the new version as soon as possible.\n\n".
            "Do you want to restart now?"
        ),
        title          => __(q{Restart Tails}),
        ok_label       => __(q{Restart now}),
        cancel_label   => __(q{Restart later}),
        default_cancel => 1,
    ) && $self->restart_system;

    exit(0);
}

method restart_system () {
    $self->info("Restarting the system");
    $self->fatal_run_cmd(
        cmd       => ['/sbin/reboot'],
        error_title => __(q{Error while restarting the system}),
        error_msg => __(q{Failed to restart the system}),
        as        => 'root',
    ) unless $ENV{HARNESS_ACTIVE};
}

method do_full_upgrade (HashRef $upgrade_path) {
    exit(0);
}

method shutdown_network () {
    $self->info("Shutting down network connection");
    $self->fatal_run_cmd(
        cmd       => ['tails-shutdown-network'],
        error_title => __(q{Error while shutting down the network}),
        error_msg => __(q{Failed to shutdown network}),
        as        => 'root',
    ) unless $ENV{HARNESS_ACTIVE};
}

method cancel_download () {
    $self->info("Cancelling the upgrade download");

    $self->fatal_run_cmd(
        cmd         => ['tails-iuk-cancel-download'],
        error_title => __(q{Error while cancelling the upgrade download}),
        error_msg   => __(q{Failed to cancel the upgrade download}),
        as          => 'root',
    ) unless $ENV{HARNESS_ACTIVE};
}

method install_iuk (HashRef $upgrade_path, AbsDir $target_files_tempdir) {
    my $title = __("Upgrading the system");
    my $info = __(
        "<b>Your Tails device is being upgraded...</b>\n\n".
        "For security reasons, the network connection is now disabled."
    );
    $self->info($info);
    my $zenity_h;
    $zenity_h = IPC::Run::start
        [qw{tail -f /dev/null}],
        '|',
        [qw{zenity --progress --pulsate --no-cancel --auto-close},
         '--title', $title, '--text', $info]
        unless $self->batch;
    $self->shutdown_network;

    my @target_files = target_files($upgrade_path, $target_files_tempdir);
    assert(@target_files == 1);

    my @args;
    push @args, (
        '--override_liveos_mountpoint', $self->override_liveos_mountpoint
    ) if $self->has_override_liveos_mountpoint;

    my @cmd = ('tails-install-iuk', @args, $target_files[0]->{output_file});
    if (! $ENV{HARNESS_ACTIVE}) {
        @cmd = ('sudo', '-n', '-u', 'tails-install-iuk', @cmd);
    }

    my ($exit_code, $stdout, $stderr);
    my $success = 0;

    $success = 1 if IPC::Run::run \@cmd, '>', \$stdout, '2>', \$stderr;
    $exit_code = $?;
    $zenity_h->kill_kill unless $self->batch;

    $success or $self->fatal(
        $self->encoding->decode(__(
            q{<b>An error occurred while installing the upgrade.</b>\n\n}.
            q{Your Tails device needs to be repaired and might be unable to restart.\n\n}.
            q{Please follow the instructions at }.
            q{file:///usr/share/doc/tails/website/doc/upgrade/error/install.en.html}
        )),
        title => __(q{Error while installing the upgrade}),
        debugging_info => $self->encoding->decode(errf(
            "exit code: %{exit_code}i\n\n".
            "stdout:\n%{stdout}s\n\n".
            "stderr:\n%{stderr}s",
            { exit_code => $exit_code, stdout => $stdout, stderr => $stderr }
        )),
    );
}

no Moo;
1;

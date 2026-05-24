=head1 NAME

Tails::IUK::TargetFile::Download - download and verify a target file

=cut

package Tails::IUK::TargetFile::Download;

no Moo::sification;
use Moo;

use 5.10.1;
use strictures 2;

use autodie qw(:all);
use Carp;
use Carp::Assert;
use Cwd;
use Digest::SHA;
use Function::Parameters;
use HTTP::Request;
use Path::Tiny;
use String::Errf qw{errf};
use Tails::IUK::LWP::UserAgent::WithProgress;
use Tails::IUK::Utils qw{space_available_in};
use Types::Path::Tiny qw{AbsPath};
use Types::Standard qw{Bool Enum InstanceOf Int Object Str};

use namespace::clean;

use MooX::Options;


=head1 ATTRIBUTES

=cut

option "$_" => (
    required => 1,
    is       => 'ro',
    isa      => Str,
    format   => 's',
) for (qw{uri hash_value});

option 'hash_type' => (
    required => 1,
    is       => 'ro',
    isa      => Enum[qw{sha256}],
    format   => 's',
);

option 'output_file' => (
    required => 1,
    is       => 'ro',
    isa      => AbsPath,
    coerce   => AbsPath->coercion,
    format   => 's',
);

has 'temp_file' => (
    is      => 'ro',
    isa     => AbsPath,
    default => sub { Path::Tiny->tempfile },
);

option 'size' => (
    required => 1,
    is       => 'ro',
    isa      => Int,
    format   => 's',
);

option 'max_attempts' => (
    is        => 'ro',
    isa       => Int,
    format    => 's',
    default   => sub { 6 },
);

has 'ua' => (
    is  => 'lazy',
    isa => InstanceOf['LWP::UserAgent'],
);

option 'exponential_backoff' => (
    is      => 'ro',
    isa     => Bool,
    format  => 's',
    default => sub { $ENV{HARNESS_ACTIVE} ? 0 : 1 },
);

# Test suite only!
option 'fail_n_times' => (
    is      => 'ro',
    isa     => Int,
    format  => 's',
    default => sub { 0 },
);

# Test suite only!
# In unpack('H*', $data) format
option 'first_byte' => (
    is        => 'ro',
    isa       => Str,
    format    => 's',
);


=head1 METHODS

=cut

method _build_ua () {
    my $ua;
    if ($ENV{HARNESS_ACTIVE} && $self->fail_n_times) {
        # When running under the test suite and we're expected to fail
        # N >= 1 times, simulate an HTTP server that only sends the first
        # byte of the requested file, for the N first download attempts:
        # this allows exercising this class' ability to resume an
        # interrupted download.
        require Test::LWP::UserAgent;
        Test::LWP::UserAgent->import;
        $ua = Test::LWP::UserAgent->new;
        $self->patch_response_handler($ua);
    } else {
        $ua = Tails::IUK::LWP::UserAgent::WithProgress->new(
            # Arguments specific to Tails::IUK::LWP::UserAgent::WithProgress
            {
                size      => $self->size,
                temp_file => $self->temp_file,
            },
            # Arguments passed to the LWP::UserAgent constructor
            ssl_opts => {
                verify_hostname => 0,
                SSL_verify_mode => 0,
            }
        );
    }
    unless ($ENV{HARNESS_ACTIVE} or $ENV{DISABLE_PROXY}) {
        $ua->proxy([qw(http https)] => 'socks://127.0.0.1:9063');
    }
    $ua->protocols_allowed([qw(http https)]);
    $ua->max_size($self->size);

    return $ua;
}

method fatal (@msg) {
    Tails::IUK::Utils::fatal(msg => \@msg);
}

method check_available_space () {
    my $target_dir      = $self->output_file->parent;
    my $space_needed    = $self->size;
    my $space_available = space_available_in($target_dir);
    $space_available >= $space_needed or $self->fatal(errf(
        "Downloading this incremental upgrade requires %{space_needed}s ".
        "of free space in %{target_dir}s, but only %{space_available}s is available.",
        {
            space_needed    => $space_needed,
            target_dir      => $target_dir,
            space_available => $space_available,
        }
    ));
}

method patch_response_handler (Object $ua) {
    my $attempted = 0;
    my $response = HTTP::Response->new(
        200, 'OK',
        HTTP::Headers->new(),
        pack('H*', $self->first_byte)
    );
    $ua->map_response(
        qr{},
        sub {
            # Disable this mapped response after N faked failures, so
            # it does not trigger for subsequent download attempts,
            # that will instead go to the "real", well-functioning
            # test web server
            if ($attempted >= $self->fail_n_times - 1) {
                say STDERR "Disabling response handler that simulated failures";
                $ua->unmap_all;
                $ua->network_fallback(1);
            }
            $attempted++;
            return $response;
        }
    );
}

method run () {
    $self->check_available_space;

    my $req = HTTP::Request->new('GET', $self->uri);

    my $temp_fh = $self->temp_file->opena_raw;
    $temp_fh->autoflush(1);

    sub clean_fatal {
        my $self   = shift;
        my $unlink = shift;
        unlink $unlink;
        $self->fatal(@_);
    }

    my $attempted = 0;
    my $sleep = 1;
    my $success;
    while ($attempted < $self->max_attempts) {
        if ($attempted > 0) {
            sleep $sleep;
            $sleep *= 2 if $self->exponential_backoff;
            my $range_start = -s $temp_fh;
            say STDERR "Resuming download after $range_start bytes";
            $req->header(Range => "bytes=${range_start}-");
        }

        say STDERR "Sending HTTP request: attempt no. " . ($attempted + 1);
        my $res = $self->ua->request($req, sub { print $temp_fh shift; });
        $attempted++;

        unless (defined $res) {
            warn(sprintf(
                "Could not download '%s' to '%s': undefined result",
                $self->uri, $self->temp_file,
            ));
            next;
        }

        for my $lwp_failure_header (qw{Client-Aborted X-Died}) {
            my $header = $res->header($lwp_failure_header);
            if (defined $header) {
                warn(sprintf(
                    "Could not download '%s' to '%s' (%s): %s",
                    $self->uri, $self->temp_file, $lwp_failure_header, $header,
                ));
                next;
            }
        }

        unless ($res->is_success) {
            warn(sprintf(
                "Could not download '%s' to '%s', request failed:\n%s\n",
                $self->uri, $self->temp_file, $res->status_line,
            ));
            next;
        }

        if (-s $self->temp_file != $self->size) {
            warn(sprintf(
                "The file '%s' was downloaded but its size (%d) should be %d",
                $self->uri, -s $self->temp_file, $self->size,
            ));
            next;
        }

        $temp_fh->close;
        $success = 1;
        last;
    }

    $success or clean_fatal($self, $self->temp_file, sprintf(
        "Could not download '%s' to '%s'",
        $self->uri, $self->temp_file,
    ));

    my $sha = Digest::SHA->new(256);
    $sha->addfile($self->temp_file->stringify);
    my $actual_hash = $sha->hexdigest;
    $actual_hash eq $self->hash_value or clean_fatal(
        $self, $self->temp_file, sprintf(
            "The file '%s' was downloaded but its hash is not correct:\n"
                . "  - expected: %s\n"
                . "  - actual:   %s",
            $self->uri,
            $self->hash_value,
            $actual_hash,
    ));

    $self->temp_file->move($self->output_file);
    # autodie is supposed to throw an exception on rename error,
    # but one can't be too careful.
    assert(-e $self->output_file);

    chmod 0644, $self->output_file;

    return 1;
}

no Moo;
1;

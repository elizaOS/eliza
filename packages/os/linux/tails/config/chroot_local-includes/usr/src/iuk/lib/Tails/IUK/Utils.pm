=head1 NAME

Tails::IUK::Utils - utilities for Tails IUK

=cut

package Tails::IUK::Utils;

use strictures 2;
use 5.10.1;

use Exporter;
our @ISA = qw{Exporter};
our @EXPORT = (
    qw{directory_size},
    qw{extract_file_from_iso extract_here_file_from_iso fatal},
    qw{run_as_root space_available_in stdout_as_root},
    qw{verify_signature}
);

use autodie qw(:all);
use Carp;
use Carp::Assert;
use Carp::Assert::More;
use Data::Dumper;
use English qw{-no_match_vars};
use File::Temp qw{tempfile};
use Filesys::Df;
use Function::Parameters;
use IPC::Run;
use IPC::System::Simple qw{capturex};
use Path::Tiny;
use String::Errf qw{errf};
use Types::Path::Tiny qw{AbsDir AbsFile Path};
use Types::Standard qw{ArrayRef Str};


=head1 FUNCTIONS

=cut

fun extract_file_from_iso(Path $file, AbsFile $iso) {
    my @cmd = qw{bsdtar -x --no-same-permissions --to-stdout --fast-read};
    push @cmd, ('--file', $iso, $file);
    open(my $cmd, '-|', @cmd);
    my $output = do { local $/; <$cmd> };
    close $cmd;
    "${^CHILD_ERROR_NATIVE}" == 0 or croak "bsdtar failed: ${^CHILD_ERROR_NATIVE}";
    return $output;
}

fun extract_here_file_from_iso($dir, $iso) {
    my @cmd = qw{bsdtar -x --no-same-permissions};
    push @cmd, ('--file', $iso, $dir);
    system(@cmd);
    "${^CHILD_ERROR_NATIVE}" == 0 or croak "bsdtar failed: ${^CHILD_ERROR_NATIVE}";
    return;
}

fun run_as_root(@command) {
    system("sudo", "-n", @command);
}

fun stdout_as_root(@command) {
    capturex(qw{sudo -n}, @command);
}

fun fatal (%args) {
    assert(exists $args{msg});
    assert_isa($args{msg}, 'ARRAY');

    chdir '/';

    if (exists $args{rmtree} && defined $args{rmtree}) {
        if (exists $args{rmtree_as_root} && defined $args{rmtree_as_root} && $args{rmtree_as_root}) {
            run_as_root(
                qw{rm --recursive --force --preserve-root}, @{$args{rmtree}}
            );
        }
        else {
            foreach my $dir (@{$args{rmtree}}) {
                path($dir)->remove_tree;
            }
        }
    }

    croak(@{$args{msg}});
}

fun directory_size (AbsDir $dir) {
    my @du = split(/\s/, capturex(qw{/usr/bin/du --block-size=1 --summarize --apparent-size}, $dir));
    return $du[0];
}

=head2 space_available_in

Returns the number of available bytes there are in directory $dir.

=cut
fun space_available_in (AbsDir $dir) {
    my $df = df($dir->stringify, 1); # "1" means "please return the value in bytes"

    assert_defined($df);
    assert_exists($df, 'bavail');
    return $df->{bavail};
}

fun verify_signature (Str $txt,
                      Str $signature_txt,
                      ArrayRef[AbsFile] $signing_keys) {
    assert_nonblank($signature_txt);

    my   ($signature_fh, $signature_file) = tempfile(CLEANUP => 1);
    print $signature_fh  $signature_txt;
    close $signature_fh;

    my   ($txt_fh,       $txt_file)       = tempfile(CLEANUP => 1);
    print $txt_fh        $txt;
    close $txt_fh;

    my ($stdout, $stderr);
    my $exit_code;
    my @cmd = (
        '/usr/bin/sqopv', 'verify',
        $signature_file,
        @{$signing_keys},
    );

    IPC::Run::run \@cmd, '<', $txt_file, '>', \$stdout, '2>', \$stderr;
    $exit_code = $?;

    if ($exit_code != 0) {
        say STDERR errf(
            "sqopv failed:\n".
            "exit code: %{exit_code}i\n\n".
            "stdout:\n%{stdout}s\n\n".
            "stderr:\n%{stderr}s",
            {
                exit_code => $exit_code,
                stdout    => $stdout,
                stderr    => $stderr,
            },
        );
    }

    return $exit_code == 0;
}

1;

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using BfresLibrary;
using BfresLibrary.Swizzling;
using Newtonsoft.Json;
using Syroot.NintenTools.NSW.Bntx;
using ZstdSharp;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length < 1 || args.Length > 2)
        {
            Console.Error.WriteLine("Usage: Decoder <LoadingIcon.bfres.zs> [output-directory]");
            return 2;
        }

        var inputPath = Path.GetFullPath(args[0]);
        var outputPath = Path.GetFullPath(args.Length == 2 ? args[1] : "assets");
        var source = File.ReadAllBytes(inputPath);
        var bfres = IsZstd(source) ? Decompress(source) : source;

        ResFile resource;
        using (var bfresStream = new MemoryStream(bfres, false))
        {
            resource = new ResFile(bfresStream, false);
        }

        var bntxData = resource.ExternalFiles["textures.bntx"].Data.ToArray();
        PatchSurfaceFormats(bntxData);

        BntxFile bntx;
        using (var bntxStream = new MemoryStream(bntxData, false))
        {
            bntx = new BntxFile(bntxStream, false);
        }

        Directory.CreateDirectory(outputPath);
        var vfi = ExtractTexture(bntx, "LoadingIcon_Vfi", 2);
        var vfp = ExtractTexture(bntx, "LoadingIcon_Vfp", 8);

        var animation = resource.ShaderParamAnims["LoadingIcon_00"];
        var material = animation.MaterialAnimDataList.Single();
        var names = new HashSet<string>(StringComparer.Ordinal)
        {
            "albedo_color",
            "transmission_color_backlight",
            "vat_anim_pos",
        };
        var parameters = material.ParamAnimInfos
            .Where(info => names.Contains(info.Name))
            .Select(info => new ParameterDump
            {
                name = info.Name,
                curves = material.Curves
                    .Skip(info.BeginCurve)
                    .Take(info.FloatCurveCount + info.IntCurveCount)
                    .Select(ToCurveDump)
                    .ToList(),
            })
            .ToList();
        var dump = new AnimationDump
        {
            name = animation.Name,
            @params = parameters,
        };
        var json = JsonConvert.SerializeObject(dump, Formatting.None);
        var bundle = "globalThis.InkLoadingAnimationAssets={curves:" +
            json +
            ",vfi:\"" +
            Convert.ToBase64String(vfi) +
            "\",vfp:\"" +
            Convert.ToBase64String(vfp) +
            "\"};";
        File.WriteAllText(
            Path.Combine(outputPath, "LoadingIcon.assets.js"),
            bundle + Environment.NewLine,
            new UTF8Encoding(false)
        );
        return 0;
    }

    private static bool IsZstd(byte[] data)
    {
        return data.Length >= 4 &&
            data[0] == 0x28 &&
            data[1] == 0xB5 &&
            data[2] == 0x2F &&
            data[3] == 0xFD;
    }

    private static byte[] Decompress(byte[] data)
    {
        using (var decompressor = new Decompressor())
        {
            var size = Decompressor.GetDecompressedSize(data, 0, data.Length);
            if (size > int.MaxValue)
            {
                throw new InvalidDataException("The decompressed BFRES is too large");
            }
            var output = new byte[(int)size];
            var length = decompressor.Unwrap(
                data,
                0,
                data.Length,
                output,
                0,
                output.Length
            );
            if (length != output.Length)
            {
                Array.Resize(ref output, length);
            }
            return output;
        }
    }

    private static void PatchSurfaceFormats(byte[] data)
    {
        var limit = Math.Min(data.Length - 3, 0x10000);
        for (var offset = 0; offset < limit; offset += 4)
        {
            if (data[offset] == 0x03 &&
                data[offset + 1] == 0x0A &&
                data[offset + 2] == 0 &&
                data[offset + 3] == 0)
            {
                data[offset] = 0x05;
            }
        }
    }

    private static byte[] ExtractTexture(
        BntxFile bntx,
        string name,
        uint bytesPerPixel
    )
    {
        var texture = bntx.Textures.Single(candidate => candidate.Name == name);
        var data = TegraX1Swizzle.deswizzle(
            texture.Width,
            texture.Height,
            texture.Depth,
            1,
            1,
            1,
            1,
            bytesPerPixel,
            (uint)texture.TileMode,
            (int)texture.BlockHeightLog2,
            texture.TextureData[0][0]
        );
        Array.Resize(
            ref data,
            checked((int)(texture.Width * texture.Height * bytesPerPixel))
        );
        return data;
    }

    private static CurveDump ToCurveDump(AnimCurve curve)
    {
        var keyCount = curve.Frames.Length;
        var elementCount = curve.Keys.GetLength(1);
        var keys = new List<KeyDump>(keyCount);
        for (var keyIndex = 0; keyIndex < keyCount; keyIndex++)
        {
            var raw = new float[elementCount];
            for (var elementIndex = 0; elementIndex < elementCount; elementIndex++)
            {
                raw[elementIndex] = curve.Keys[keyIndex, elementIndex];
            }
            keys.Add(new KeyDump
            {
                frame = curve.Frames[keyIndex],
                raw = raw,
            });
        }
        return new CurveDump
        {
            type = curve.CurveType.ToString(),
            scale = curve.Scale,
            offset = curve.Offset.Single,
            keys = keys,
        };
    }

    private sealed class AnimationDump
    {
        public string name { get; set; }
        public List<ParameterDump> @params { get; set; }
    }

    private sealed class ParameterDump
    {
        public string name { get; set; }
        public List<CurveDump> curves { get; set; }
    }

    private sealed class CurveDump
    {
        public string type { get; set; }
        public float scale { get; set; }
        public float offset { get; set; }
        public List<KeyDump> keys { get; set; }
    }

    private sealed class KeyDump
    {
        public float frame { get; set; }
        public float[] raw { get; set; }
    }
}

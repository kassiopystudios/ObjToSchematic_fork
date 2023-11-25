import { AppConfig } from "../config";
import { GeometryTemplates } from "./geometry";
import { AttributeData } from "./render_buffer";
import { OtSE_AmbientOcclusion } from "./ambient_occlusion";
import { OtS_Voxel, OtS_VoxelMesh } from '../../../Core/src/ots_voxel_mesh';
import { OtS_VoxelMesh_Neighbourhood } from '../../../Core/src/ots_voxel_mesh_neighbourhood';
import { TOptional } from "ots-core/src/util/types";
import { ASSERT, OtS_Util } from "ots-core/src/util/util";
import { Vector3 } from "ots-core/src/util/vector";
import { AppConstants } from "ots-core/src/util/constants";

export type TVoxelMeshBuffer = {
    position: { numComponents: 3, data: Float32Array, },
    colour: { numComponents: 4, data: Float32Array },
    occlusion: { numComponents: 4, data: Float32Array },
    texcoord: { numComponents: 2, data: Float32Array },
    normal: { numComponents: 3, data: Float32Array },
    indices: { numComponents: 3, data: Uint32Array },
};

export type TVoxelMeshBufferDescription = {
    buffer: TVoxelMeshBuffer,
    numElements: number,
}

export type TBuffer_VoxelMesh = TVoxelMeshBufferDescription & { moreVoxelsToBuffer: boolean, progress: number };

export class BufferGenerator_VoxelMesh {
    private _voxelMesh: OtS_VoxelMesh;
    private _voxels: OtS_Voxel[];

    private _createAmbientOcclusionBuffer: boolean;
    private _nextChunkIndex: number;
    private _numTotalVoxels: number;
    private _cache: Map<number, TBuffer_VoxelMesh>;
    private _neighbourhood: OtS_VoxelMesh_Neighbourhood | null;

    public constructor(voxelMesh: OtS_VoxelMesh, createAmbientOcclusionBuffer: boolean) {
        this._voxelMesh = voxelMesh;
        this._voxels = Array.from(voxelMesh.getVoxels());

        this._createAmbientOcclusionBuffer = createAmbientOcclusionBuffer;
        this._nextChunkIndex = 0;
        this._numTotalVoxels = voxelMesh.getVoxelCount();
        this._cache = new Map();

        if (this._createAmbientOcclusionBuffer) {
            this._neighbourhood = new OtS_VoxelMesh_Neighbourhood();
            this._neighbourhood.process(this._voxelMesh, 'non-cardinal');
        } else {
            this._neighbourhood = null;
        }
    }

    public getNext() {
        const buffer = this._fromVoxelMesh(this._nextChunkIndex);
        this._cache.set(this._nextChunkIndex, buffer);
        ++this._nextChunkIndex;
        return buffer;
    }

    public getFromIndex(index: number): TOptional<TBuffer_VoxelMesh> {
        return this._cache.get(index);
    }

    private _fromVoxelMesh(chunkIndex: number): TBuffer_VoxelMesh {
        const voxelsStartIndex = chunkIndex * AppConfig.Get.VOXEL_BUFFER_CHUNK_SIZE;
        const voxelsEndIndex = Math.min((chunkIndex + 1) * AppConfig.Get.VOXEL_BUFFER_CHUNK_SIZE, this._numTotalVoxels);
        ASSERT(voxelsStartIndex < this._numTotalVoxels, 'Invalid voxel start index');

        const numBufferVoxels = voxelsEndIndex - voxelsStartIndex;
        const newBuffer: TVoxelMeshBuffer = BufferGenerator_VoxelMesh.createVoxelMeshBuffer(numBufferVoxels);

        const cube: AttributeData = GeometryTemplates.getBoxBufferData(new Vector3(0, 0, 0));

        // Build position buffer
        for (let i = 0; i < numBufferVoxels; ++i) {
            const voxel = this._voxels[i + voxelsStartIndex];
            const voxelPositionArray = voxel.position.toArray();

            for (let j = 0; j < AppConstants.VoxelMeshBufferComponentOffsets.POSITION; ++j) {
                newBuffer.position.data[i * AppConstants.VoxelMeshBufferComponentOffsets.POSITION + j] = cube.custom.position[j] + voxelPositionArray[j % 3];
            }
        }

        // Build colour buffer
        for (let i = 0; i < numBufferVoxels; ++i) {
            const voxel = this._voxels[i + voxelsStartIndex];
            newBuffer.colour.data[i * 96 + 0] = voxel.colour.r;
            newBuffer.colour.data[i * 96 + 1] = voxel.colour.g;
            newBuffer.colour.data[i * 96 + 2] = voxel.colour.b;
            newBuffer.colour.data[i * 96 + 3] = voxel.colour.a;

            OtS_Util.Array.repeatedFill(newBuffer.colour.data, i * 96, 4, 24);
        }

        // Build normal buffer
        {
            newBuffer.normal.data.set(cube.custom.normal, 0);
            OtS_Util.Array.repeatedFill(newBuffer.normal.data, 0, 72, numBufferVoxels);
        }

        // Build texcoord buffer
        {
            newBuffer.texcoord.data.set(cube.custom.texcoord, 0);
            OtS_Util.Array.repeatedFill(newBuffer.texcoord.data, 0, 48, numBufferVoxels);
        }


        // Build indices buffer
        for (let i = 0; i < numBufferVoxels; ++i) {
            for (let j = 0; j < AppConstants.VoxelMeshBufferComponentOffsets.INDICES; ++j) {
                newBuffer.indices.data[i * AppConstants.VoxelMeshBufferComponentOffsets.INDICES + j] = cube.indices[j] + (i * AppConstants.INDICES_PER_VOXEL);
            }
        }

        // Build occlusion buffer
        if (this._createAmbientOcclusionBuffer) {
            ASSERT(this._neighbourhood !== null);

            const voxelOcclusionArray = new Float32Array(96);

            for (let i = 0; i < numBufferVoxels; ++i) {
                const voxel = this._voxels[i + voxelsStartIndex];
                OtSE_AmbientOcclusion.GetOcclusions(voxelOcclusionArray, voxel.position, this._neighbourhood);

                newBuffer.occlusion.data.set(voxelOcclusionArray, i * AppConstants.VoxelMeshBufferComponentOffsets.OCCLUSION);
            }
        }

        return {
            buffer: newBuffer,
            numElements: newBuffer.indices.data.length,
            moreVoxelsToBuffer: voxelsEndIndex !== this._numTotalVoxels,
            progress: voxelsStartIndex / this._numTotalVoxels,
        };
    }

    public static createVoxelMeshBuffer(numVoxels: number): TVoxelMeshBuffer {
        return {
            position: {
                numComponents: 3,
                data: new Float32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.POSITION),
            },
            colour: {
                numComponents: 4,
                data: new Float32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.COLOUR),
            },
            occlusion: {
                numComponents: 4,
                data: new Float32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.OCCLUSION).fill(1.0),
            },
            texcoord: {
                numComponents: 2,
                data: new Float32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.TEXCOORD),
            },
            normal: {
                numComponents: 3,
                data: new Float32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.NORMAL),
            },
            indices: {
                numComponents: 3,
                data: new Uint32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.INDICES),
            },
        };
    }
}